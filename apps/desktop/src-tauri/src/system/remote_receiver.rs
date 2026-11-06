use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::future::Future;
use std::net::UdpSocket;
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter};
use tokio::io::BufReader;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};

use super::remote_protocol::{read_frame, secret_matches, trusted_for, write_frame, DeviceRole};
use crate::state::{RemoteReceiverState, RemoteReceiverStatus};

const MAX_CONNECTIONS: usize = 32;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Consecutive `accept` errors tolerated before the listener gives up.
const MAX_ACCEPT_FAILURES: u32 = 5;
/// Pause between accept retries, so a saturated descriptor table cannot spin.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(50);

pub const EVT_REMOTE_FINAL_TEXT_RECEIVED: &str = "remote_final_text_received";

struct AuthenticatedSession {
    sender_id: String,
    session_id: String,
    token: String,
}

async fn authorized_sender(
    pool: SqlitePool,
    session: Option<&AuthenticatedSession>,
    session_id: &str,
) -> Result<Option<String>, String> {
    let Some(session) = session.filter(|session| session.session_id == session_id) else {
        return Ok(None);
    };
    let device = crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
        pool,
        &session.sender_id,
    )
    .await
    .map_err(|err| format!("Failed to validate sender device: {err}"))?;
    Ok(device
        .filter(|device| {
            trusted_for(device, DeviceRole::Sender)
                && secret_matches(&device.shared_secret, &session.token)
        })
        .map(|_| session.sender_id.clone()))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IncomingEnvelope {
    PairingRequest {
        request_id: String,
        sender_device_id: String,
        sender_device_name: String,
        sender_platform: String,
        pairing_code: String,
    },
    SessionHello {
        session_id: String,
        sender_device_id: String,
        auth_token: String,
    },
    FinalText {
        session_id: String,
        event_id: String,
        sequence: u64,
        text: String,
        mode: String,
        created_at: String,
    },
    Heartbeat {
        session_id: String,
        sent_at: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutgoingEnvelope {
    PairingAccept {
        request_id: String,
        receiver_device_id: String,
        receiver_device_name: String,
        receiver_platform: String,
        shared_secret: String,
    },
    SessionAck {
        session_id: String,
        receiver_device_id: String,
    },
    DeliveryAck {
        session_id: String,
        event_id: String,
        sequence: u64,
        delivered_at: String,
    },
    DeliveryError {
        session_id: String,
        event_id: String,
        sequence: u64,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFinalTextReceivedPayload {
    pub sender_device_id: String,
    pub event_id: String,
    pub text: String,
    pub mode: String,
    pub created_at: String,
}

pub async fn start(
    app: AppHandle,
    state: RemoteReceiverState,
    pool: SqlitePool,
    port: Option<u16>,
) -> Result<RemoteReceiverStatus, String> {
    let Some(generation) = state.prepare_start() else {
        return Ok(state.status());
    };

    let bind_port = port.unwrap_or(0);
    let listener = TcpListener::bind(("0.0.0.0", bind_port))
        .await
        .map_err(|err| format!("Failed to bind receiver listener: {err}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to get receiver listener address: {err}"))?;
    let connect_address = detect_connect_address().unwrap_or_else(|| "127.0.0.1".to_string());

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    if !state.start_if_current(&generation, connect_address, local_addr.port(), shutdown_tx) {
        return if state.is_enabled() {
            Ok(state.status())
        } else {
            Err("Remote receiver start was cancelled.".to_string())
        };
    }

    let state_for_task = state.clone();
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    async_runtime::spawn(async move {
        let mut accept_failures = 0u32;
        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => {
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            accept_failures = 0;
                            let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
                                continue;
                            };
                            let state = state_for_task.clone();
                            let pool = pool.clone();
                            let app = app.clone();
                            let shutdown = shutdown_rx.clone();
                            async_runtime::spawn(async move {
                                let _permit = permit;
                                if let Some(Err(err)) = until_shutdown(
                                    shutdown,
                                    handle_connection(stream, pool, state, app),
                                ).await {
                                    log::error!("Remote receiver connection failed: {err}");
                                }
                            });
                        }
                        Err(err) => {
                            // A peer that resets between the handshake and
                            // `accept`, or a momentarily exhausted descriptor
                            // table, fails one call and not the listener. Give
                            // up only after repeated failures, and then leave
                            // the status disabled so the UI cannot show a
                            // receiver that stopped listening.
                            accept_failures += 1;
                            log::error!("Remote receiver accept failed ({accept_failures}): {err}");
                            if accept_failures >= MAX_ACCEPT_FAILURES {
                                state_for_task.record_error(
                                    None,
                                    None,
                                    format!(
                                        "Remote receiver stopped after {accept_failures} accept failures: {err}"
                                    ),
                                    None,
                                    None,
                                    None,
                                );
                                state_for_task.stop();
                                break;
                            }
                            tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                        }
                    }
                }
            }
        }
    });

    Ok(state.status())
}

async fn until_shutdown<F: Future>(
    mut shutdown: watch::Receiver<bool>,
    work: F,
) -> Option<F::Output> {
    if *shutdown.borrow() {
        return None;
    }
    tokio::select! {
        biased;
        _ = shutdown.changed() => None,
        result = work => Some(result),
    }
}

/// Pick a "best-guess" LAN IP address the companion device can use to reach
/// this machine, without actually sending any packet.
///
/// We use the standard "UDP connect to a TEST-NET address" trick (RFC 5737 —
/// `192.0.2.0/24` is reserved documentation range and is guaranteed not to
/// host a real host): `connect()` on a connectionless UDP socket does NOT
/// send traffic; it only pins a source address chosen by the OS routing
/// table for that destination, which on a normal home LAN resolves to the
/// machine's private IPv4. The socket is dropped immediately after reading
/// the local address.
fn detect_connect_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let local_addr = socket.local_addr().ok()?;
    let ip = local_addr.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

pub fn stop(state: RemoteReceiverState) {
    state.stop();
}

fn generate_shared_secret() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn handle_connection(
    stream: TcpStream,
    pool: SqlitePool,
    state: RemoteReceiverState,
    app: AppHandle,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut authenticated_session: Option<AuthenticatedSession> = None;

    while let Some(line) = tokio::time::timeout(READ_TIMEOUT, read_frame(&mut reader))
        .await
        .map_err(|_| "Timed out waiting for a remote message.".to_string())?
        .map_err(|err| format!("Failed to read receiver message: {err}"))?
    {
        let envelope: IncomingEnvelope = serde_json::from_str(&line)
            .map_err(|err| format!("Failed to parse receiver message: {err}"))?;

        match envelope {
            IncomingEnvelope::PairingRequest {
                request_id,
                sender_device_id,
                sender_device_name,
                sender_platform,
                pairing_code,
            } => {
                if !state.consume_pairing_code(&pairing_code) {
                    state.record_error(
                        Some(sender_device_id.clone()),
                        None,
                        "Pairing code is invalid.".to_string(),
                        None,
                        None,
                        None,
                    );
                    write_message(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id: String::new(),
                            event_id: String::new(),
                            sequence: 0,
                            code: "invalid_pairing_code".to_string(),
                            message: "Pairing code is invalid.".to_string(),
                        },
                    )
                    .await?;
                    continue;
                }

                let shared_secret = generate_shared_secret();
                let sender_device = crate::domain::PairedRemoteDevice {
                    id: sender_device_id.clone(),
                    name: sender_device_name,
                    platform: sender_platform,
                    role: "sender".to_string(),
                    shared_secret: shared_secret.clone(),
                    paired_at: chrono::Utc::now().to_rfc3339(),
                    last_seen_at: None,
                    last_known_address: None,
                    trusted: true,
                };

                crate::db::paired_remote_device_queries::upsert_paired_remote_device(
                    pool.clone(),
                    &sender_device,
                )
                .await
                .map_err(|err| format!("Failed to store paired sender: {err}"))?;

                let receiver_status = state.status();
                write_message(
                    &mut writer,
                    &OutgoingEnvelope::PairingAccept {
                        request_id,
                        receiver_device_id: receiver_status.device_id,
                        receiver_device_name: receiver_status.device_name,
                        receiver_platform: receiver_status.device_platform,
                        shared_secret,
                    },
                )
                .await?;
            }
            IncomingEnvelope::SessionHello {
                session_id,
                sender_device_id,
                auth_token,
            } => {
                authenticated_session = None;
                let device =
                    crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
                        pool.clone(),
                        &sender_device_id,
                    )
                    .await
                    .map_err(|err| format!("Failed to validate sender device: {err}"))?;

                let Some(device) = device else {
                    state.record_error(
                        Some(sender_device_id.clone()),
                        None,
                        "Sender is not paired.".to_string(),
                        None,
                        None,
                        None,
                    );
                    write_message(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id,
                            event_id: String::new(),
                            sequence: 0,
                            code: "unknown_sender".to_string(),
                            message: "Sender is not paired.".to_string(),
                        },
                    )
                    .await?;
                    continue;
                };

                if !trusted_for(&device, DeviceRole::Sender) || device.shared_secret != auth_token {
                    state.record_error(
                        Some(sender_device_id.clone()),
                        None,
                        "Sender authentication failed.".to_string(),
                        None,
                        None,
                        None,
                    );
                    write_message(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id,
                            event_id: String::new(),
                            sequence: 0,
                            code: "unauthorized".to_string(),
                            message: "Sender authentication failed.".to_string(),
                        },
                    )
                    .await?;
                    continue;
                }

                authenticated_session = Some(AuthenticatedSession {
                    sender_id: sender_device_id,
                    session_id: session_id.clone(),
                    token: auth_token,
                });
                write_message(
                    &mut writer,
                    &OutgoingEnvelope::SessionAck {
                        session_id,
                        receiver_device_id: state.status().device_id,
                    },
                )
                .await?;
            }
            IncomingEnvelope::FinalText {
                session_id,
                event_id,
                sequence,
                text,
                mode,
                created_at,
            } => {
                let sender =
                    authorized_sender(pool.clone(), authenticated_session.as_ref(), &session_id)
                        .await?;
                let Some(sender_device_id) = sender else {
                    authenticated_session = None;
                    state.record_error(
                        None,
                        Some(event_id.clone()),
                        "No authenticated sender session.".to_string(),
                        None,
                        None,
                        None,
                    );
                    write_message(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id,
                            event_id,
                            sequence,
                            code: "unauthorized".to_string(),
                            message: "No authenticated sender session.".to_string(),
                        },
                    )
                    .await?;
                    continue;
                };

                if mode == "test" {
                    let delivered_at = chrono::Utc::now().to_rfc3339();
                    state.record_delivery(
                        Some(sender_device_id),
                        Some(event_id.clone()),
                        Some(delivered_at.clone()),
                        None,
                        None,
                        None,
                    );
                    write_message(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryAck {
                            session_id,
                            event_id,
                            sequence,
                            delivered_at,
                        },
                    )
                    .await?;
                    continue;
                }

                let target_info = current_target_info();
                let target_editable = current_target_editable_status();
                let payload = RemoteFinalTextReceivedPayload {
                    sender_device_id: sender_device_id.clone(),
                    event_id: event_id.clone(),
                    text: text.clone(),
                    mode,
                    created_at,
                };

                match app.emit(EVT_REMOTE_FINAL_TEXT_RECEIVED, payload) {
                    Ok(()) => {
                        let delivered_at = chrono::Utc::now().to_rfc3339();
                        state.record_delivery(
                            Some(sender_device_id),
                            Some(event_id.clone()),
                            Some(delivered_at.clone()),
                            target_info.class_name.clone(),
                            target_info.title.clone(),
                            target_editable,
                        );
                        write_message(
                            &mut writer,
                            &OutgoingEnvelope::DeliveryAck {
                                session_id,
                                event_id,
                                sequence,
                                delivered_at,
                            },
                        )
                        .await?;
                    }
                    Err(err) => {
                        let message = format!("Failed to emit remote transcript event: {err}");
                        state.record_error(
                            Some(sender_device_id),
                            Some(event_id.clone()),
                            message.clone(),
                            target_info.class_name.clone(),
                            target_info.title.clone(),
                            target_editable,
                        );
                        write_message(
                            &mut writer,
                            &OutgoingEnvelope::DeliveryError {
                                session_id,
                                event_id,
                                sequence,
                                code: "event_emit_failed".to_string(),
                                message,
                            },
                        )
                        .await?;
                    }
                }
            }
            IncomingEnvelope::Heartbeat {
                session_id,
                sent_at: _sent_at,
            } => {
                write_message(
                    &mut writer,
                    &OutgoingEnvelope::SessionAck {
                        session_id,
                        receiver_device_id: state.status().device_id,
                    },
                )
                .await?;
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn current_target_info() -> crate::platform::windows::input::WindowTargetInfo {
    crate::platform::windows::input::get_foreground_window_target_info()
}

#[cfg(target_os = "windows")]
fn current_target_editable_status() -> Option<bool> {
    Some(crate::platform::accessibility::is_text_input_focused())
}

#[cfg(not(target_os = "windows"))]
fn current_target_info() -> FallbackWindowTargetInfo {
    FallbackWindowTargetInfo {
        class_name: None,
        title: None,
    }
}

#[cfg(not(target_os = "windows"))]
fn current_target_editable_status() -> Option<bool> {
    None
}

#[cfg(not(target_os = "windows"))]
struct FallbackWindowTargetInfo {
    class_name: Option<String>,
    title: Option<String>,
}

async fn write_message(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    message: &OutgoingEnvelope,
) -> Result<(), String> {
    write_frame(writer, message)
        .await
        .map_err(|err| format!("Failed to write receiver message: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct DropSignal(Arc<AtomicBool>);
    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn shutdown_retires_existing_connection_work() {
        let (sender, receiver) = watch::channel(false);
        let dropped = Arc::new(AtomicBool::new(false));
        let signal = DropSignal(Arc::clone(&dropped));
        let task = tokio::spawn(until_shutdown(receiver, async move {
            let _signal = signal;
            std::future::pending::<()>().await;
        }));
        tokio::task::yield_now().await;
        sender.send(true).unwrap();
        assert_eq!(task.await.unwrap(), None);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn deliveries_require_the_current_session_and_current_trust() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE paired_remote_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, role TEXT NOT NULL, shared_secret TEXT NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT, last_known_address TEXT, trusted INTEGER NOT NULL)")
            .execute(&pool).await.unwrap();
        let device = crate::domain::PairedRemoteDevice {
            id: "sender".into(),
            name: "sender".into(),
            platform: "windows".into(),
            role: "sender".into(),
            shared_secret: "secret".into(),
            paired_at: "now".into(),
            last_seen_at: None,
            last_known_address: None,
            trusted: true,
        };
        crate::db::paired_remote_device_queries::upsert_paired_remote_device(pool.clone(), &device)
            .await
            .unwrap();
        let session = AuthenticatedSession {
            sender_id: "sender".into(),
            session_id: "session".into(),
            token: "secret".into(),
        };
        assert_eq!(
            authorized_sender(pool.clone(), Some(&session), "session")
                .await
                .unwrap()
                .as_deref(),
            Some("sender")
        );
        assert!(authorized_sender(pool.clone(), Some(&session), "other")
            .await
            .unwrap()
            .is_none());
        sqlx::query("UPDATE paired_remote_devices SET role = 'receiver' WHERE id = 'sender'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(authorized_sender(pool.clone(), Some(&session), "session")
            .await
            .unwrap()
            .is_none());
        sqlx::query("UPDATE paired_remote_devices SET role = 'sender' WHERE id = 'sender'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE paired_remote_devices SET trusted = 0 WHERE id = 'sender'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(authorized_sender(pool.clone(), Some(&session), "session")
            .await
            .unwrap()
            .is_none());
        sqlx::query("UPDATE paired_remote_devices SET trusted = 1, shared_secret = 'new-secret' WHERE id = 'sender'").execute(&pool).await.unwrap();
        assert!(authorized_sender(pool.clone(), Some(&session), "session")
            .await
            .unwrap()
            .is_none());
        sqlx::query("DELETE FROM paired_remote_devices WHERE id = 'sender'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(authorized_sender(pool, Some(&session), "session")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn shutdown_closes_an_accepted_socket_while_a_frame_is_incomplete() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let (sender, receiver) = watch::channel(false);
        let task = tokio::spawn(until_shutdown(receiver, async move {
            let mut reader = BufReader::new(socket);
            read_frame(&mut reader).await
        }));
        client.write_all(b"partial").await.unwrap();
        tokio::task::yield_now().await;
        sender.send(true).unwrap();
        assert!(task.await.unwrap().is_none());
        let mut byte = [0_u8; 1];
        match tokio::time::timeout(Duration::from_secs(1), client.read(&mut byte))
            .await
            .unwrap()
        {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("socket remained open: {other:?}"),
        }
    }

    #[tokio::test]
    async fn already_stopped_connections_do_not_start() {
        let (_sender, receiver) = watch::channel(true);
        let entered = Arc::new(AtomicBool::new(false));
        let marker = Arc::clone(&entered);
        assert_eq!(
            until_shutdown(receiver, async move {
                marker.store(true, Ordering::SeqCst);
            })
            .await,
            None
        );
        assert!(!entered.load(Ordering::SeqCst));
    }
}
