use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::net::UdpSocket;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::state::{RemoteReceiverState, RemoteReceiverStatus};

pub const EVT_REMOTE_FINAL_TEXT_RECEIVED: &str = "remote_final_text_received";

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
    let write_generation = crate::db::local_data_write_gate::current_write_generation()
        .ok_or_else(|| "Local data is being cleared".to_string())?;
    if state.is_enabled() {
        return Ok(state.status());
    }

    let bind_port = port.unwrap_or(0);
    let listener = TcpListener::bind(("0.0.0.0", bind_port))
        .await
        .map_err(|err| format!("Failed to bind receiver listener: {err}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to get receiver listener address: {err}"))?;
    let connect_address = detect_connect_address().unwrap_or_else(|| "127.0.0.1".to_string());

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    {
        let _start_guard =
            crate::db::local_data_write_gate::lock_local_data_write(Some(write_generation))
                .await
                .map_err(|err| err.to_string())?;
        if state.is_enabled() {
            return Ok(state.status());
        }
        state.start(connect_address, local_addr.port(), shutdown_tx);
    }

    let state_for_task = state.clone();
    async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            let Some(write_generation) =
                                crate::db::local_data_write_gate::current_write_generation()
                            else {
                                continue;
                            };
                            let state = state_for_task.clone();
                            let receiver_generation = state.generation();
                            if !state.is_generation_active(receiver_generation) {
                                continue;
                            }
                            let pool = pool.clone();
                            let app = app.clone();
                            let connection_shutdown = shutdown_rx.clone();
                            async_runtime::spawn(async move {
                                if let Err(err) = handle_connection(
                                    stream,
                                    pool,
                                    state,
                                    app,
                                    write_generation,
                                    receiver_generation,
                                    connection_shutdown,
                                )
                                .await
                                {
                                    log::error!("Remote receiver connection failed: {err}");
                                }
                            });
                        }
                        Err(err) => {
                            log::error!("Remote receiver accept failed: {err}");
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(state.status())
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

fn is_connection_current(
    state: &RemoteReceiverState,
    receiver_generation: u64,
    write_generation: u64,
) -> bool {
    state.is_generation_active(receiver_generation)
        && crate::db::local_data_write_gate::is_write_generation_current(write_generation)
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow() {
        return;
    }
    let _ = shutdown.changed().await;
}

async fn write_message_while_active(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    message: &OutgoingEnvelope,
    shutdown: &mut watch::Receiver<bool>,
    state: &RemoteReceiverState,
    receiver_generation: u64,
    write_generation: u64,
) -> Result<bool, String> {
    if !is_connection_current(state, receiver_generation, write_generation) {
        return Ok(false);
    }

    tokio::select! {
        result = write_message(writer, message) => {
            result?;
            Ok(is_connection_current(state, receiver_generation, write_generation))
        }
        _ = wait_for_shutdown(shutdown) => Ok(false),
    }
}

#[derive(Default)]
struct RemoteReceiverEventDetails {
    sender_device_id: Option<String>,
    event_id: Option<String>,
    target_class_name: Option<String>,
    target_title: Option<String>,
    target_editable: Option<bool>,
}

async fn record_error_while_active(
    state: &RemoteReceiverState,
    receiver_generation: u64,
    write_generation: u64,
    details: RemoteReceiverEventDetails,
    message: String,
) -> bool {
    let Ok(_write_guard) =
        crate::db::local_data_write_gate::lock_local_data_write(Some(write_generation)).await
    else {
        return false;
    };
    if !is_connection_current(state, receiver_generation, write_generation) {
        return false;
    }
    state.record_error_for_generation(
        receiver_generation,
        details.sender_device_id,
        details.event_id,
        message,
        details.target_class_name,
        details.target_title,
        details.target_editable,
    )
}

async fn record_delivery_while_active(
    state: &RemoteReceiverState,
    receiver_generation: u64,
    write_generation: u64,
    details: RemoteReceiverEventDetails,
    delivered_at: Option<String>,
) -> bool {
    let Ok(_write_guard) =
        crate::db::local_data_write_gate::lock_local_data_write(Some(write_generation)).await
    else {
        return false;
    };
    if !is_connection_current(state, receiver_generation, write_generation) {
        return false;
    }
    state.record_delivery_for_generation(
        receiver_generation,
        details.sender_device_id,
        details.event_id,
        delivered_at,
        details.target_class_name,
        details.target_title,
        details.target_editable,
    )
}

async fn rotate_pairing_code_while_active(
    state: &RemoteReceiverState,
    receiver_generation: u64,
    write_generation: u64,
) -> bool {
    let Ok(_write_guard) =
        crate::db::local_data_write_gate::lock_local_data_write(Some(write_generation)).await
    else {
        return false;
    };
    is_connection_current(state, receiver_generation, write_generation)
        && state.rotate_pairing_code_for_generation(receiver_generation)
}

async fn handle_connection(
    stream: TcpStream,
    pool: SqlitePool,
    state: RemoteReceiverState,
    app: AppHandle,
    write_generation: u64,
    receiver_generation: u64,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    if !is_connection_current(&state, receiver_generation, write_generation) {
        return Ok(());
    }

    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let mut authenticated_sender: Option<String> = None;

    loop {
        let line = tokio::select! {
            result = lines.next_line() => {
                result.map_err(|err| format!("Failed to read receiver message: {err}"))?
            }
            _ = wait_for_shutdown(&mut shutdown) => return Ok(()),
        };
        let Some(line) = line else {
            break;
        };
        if !is_connection_current(&state, receiver_generation, write_generation) {
            return Ok(());
        }
        let envelope: IncomingEnvelope = serde_json::from_str(&line)
            .map_err(|err| format!("Failed to parse receiver message: {err}"))?;
        if !is_connection_current(&state, receiver_generation, write_generation) {
            return Ok(());
        }

        match envelope {
            IncomingEnvelope::PairingRequest {
                request_id,
                sender_device_id,
                sender_device_name,
                sender_platform,
                pairing_code,
            } => {
                if pairing_code != state.status().pairing_code {
                    if !record_error_while_active(
                        &state,
                        receiver_generation,
                        write_generation,
                        RemoteReceiverEventDetails {
                            sender_device_id: Some(sender_device_id),
                            ..RemoteReceiverEventDetails::default()
                        },
                        "Pairing code is invalid.".to_string(),
                    )
                    .await
                    {
                        return Ok(());
                    }
                    if !write_message_while_active(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id: String::new(),
                            event_id: String::new(),
                            sequence: 0,
                            code: "invalid_pairing_code".to_string(),
                            message: "Pairing code is invalid.".to_string(),
                        },
                        &mut shutdown,
                        &state,
                        receiver_generation,
                        write_generation,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    continue;
                }

                let shared_secret = generate_shared_secret();
                let sender_device = crate::domain::PairedRemoteDevice {
                    id: sender_device_id,
                    name: sender_device_name,
                    platform: sender_platform,
                    role: "sender".to_string(),
                    shared_secret: shared_secret.clone(),
                    paired_at: chrono::Utc::now().to_rfc3339(),
                    last_seen_at: None,
                    last_known_address: None,
                    trusted: true,
                };

                if !is_connection_current(&state, receiver_generation, write_generation) {
                    return Ok(());
                }
                if let Err(err) =
                    crate::db::paired_remote_device_queries::upsert_paired_remote_device_for_generation(
                        pool.clone(),
                        &sender_device,
                        write_generation,
                    )
                    .await
                {
                    if !is_connection_current(&state, receiver_generation, write_generation) {
                        return Ok(());
                    }
                    return Err(format!("Failed to store paired sender: {err}"));
                }
                if !is_connection_current(&state, receiver_generation, write_generation)
                    || !rotate_pairing_code_while_active(
                        &state,
                        receiver_generation,
                        write_generation,
                    )
                    .await
                {
                    return Ok(());
                }

                let receiver_status = state.status();
                if !write_message_while_active(
                    &mut writer,
                    &OutgoingEnvelope::PairingAccept {
                        request_id,
                        receiver_device_id: receiver_status.device_id,
                        receiver_device_name: receiver_status.device_name,
                        receiver_platform: receiver_status.device_platform,
                        shared_secret,
                    },
                    &mut shutdown,
                    &state,
                    receiver_generation,
                    write_generation,
                )
                .await?
                {
                    return Ok(());
                }
            }
            IncomingEnvelope::SessionHello {
                session_id,
                sender_device_id,
                auth_token,
            } => {
                let device_result =
                    crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
                        pool.clone(),
                        &sender_device_id,
                    )
                    .await;
                if !is_connection_current(&state, receiver_generation, write_generation) {
                    return Ok(());
                }
                let device = device_result
                    .map_err(|err| format!("Failed to validate sender device: {err}"))?;

                let Some(device) = device else {
                    if !record_error_while_active(
                        &state,
                        receiver_generation,
                        write_generation,
                        RemoteReceiverEventDetails {
                            sender_device_id: Some(sender_device_id),
                            ..RemoteReceiverEventDetails::default()
                        },
                        "Sender is not paired.".to_string(),
                    )
                    .await
                    {
                        return Ok(());
                    }
                    if !write_message_while_active(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id,
                            event_id: String::new(),
                            sequence: 0,
                            code: "unknown_sender".to_string(),
                            message: "Sender is not paired.".to_string(),
                        },
                        &mut shutdown,
                        &state,
                        receiver_generation,
                        write_generation,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    continue;
                };

                if !device.trusted || device.shared_secret != auth_token {
                    if !record_error_while_active(
                        &state,
                        receiver_generation,
                        write_generation,
                        RemoteReceiverEventDetails {
                            sender_device_id: Some(sender_device_id),
                            ..RemoteReceiverEventDetails::default()
                        },
                        "Sender authentication failed.".to_string(),
                    )
                    .await
                    {
                        return Ok(());
                    }
                    if !write_message_while_active(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id,
                            event_id: String::new(),
                            sequence: 0,
                            code: "unauthorized".to_string(),
                            message: "Sender authentication failed.".to_string(),
                        },
                        &mut shutdown,
                        &state,
                        receiver_generation,
                        write_generation,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    continue;
                }

                if !is_connection_current(&state, receiver_generation, write_generation) {
                    return Ok(());
                }
                authenticated_sender = Some(sender_device_id);
                if !write_message_while_active(
                    &mut writer,
                    &OutgoingEnvelope::SessionAck {
                        session_id,
                        receiver_device_id: state.status().device_id,
                    },
                    &mut shutdown,
                    &state,
                    receiver_generation,
                    write_generation,
                )
                .await?
                {
                    return Ok(());
                }
            }
            IncomingEnvelope::FinalText {
                session_id,
                event_id,
                sequence,
                text,
                mode,
                created_at,
            } => {
                let Some(sender_device_id) = authenticated_sender.clone() else {
                    if !record_error_while_active(
                        &state,
                        receiver_generation,
                        write_generation,
                        RemoteReceiverEventDetails {
                            event_id: Some(event_id.clone()),
                            ..RemoteReceiverEventDetails::default()
                        },
                        "No authenticated sender session.".to_string(),
                    )
                    .await
                    {
                        return Ok(());
                    }
                    if !write_message_while_active(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryError {
                            session_id,
                            event_id,
                            sequence,
                            code: "unauthorized".to_string(),
                            message: "No authenticated sender session.".to_string(),
                        },
                        &mut shutdown,
                        &state,
                        receiver_generation,
                        write_generation,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    continue;
                };

                if mode == "test" {
                    let delivered_at = chrono::Utc::now().to_rfc3339();
                    if !record_delivery_while_active(
                        &state,
                        receiver_generation,
                        write_generation,
                        RemoteReceiverEventDetails {
                            sender_device_id: Some(sender_device_id),
                            event_id: Some(event_id.clone()),
                            ..RemoteReceiverEventDetails::default()
                        },
                        Some(delivered_at.clone()),
                    )
                    .await
                    {
                        return Ok(());
                    }
                    if !write_message_while_active(
                        &mut writer,
                        &OutgoingEnvelope::DeliveryAck {
                            session_id,
                            event_id,
                            sequence,
                            delivered_at,
                        },
                        &mut shutdown,
                        &state,
                        receiver_generation,
                        write_generation,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    continue;
                }

                let target_info = current_target_info();
                let target_editable = current_target_editable_status();
                let payload = RemoteFinalTextReceivedPayload {
                    sender_device_id: sender_device_id.clone(),
                    event_id: event_id.clone(),
                    text,
                    mode,
                    created_at,
                };

                let emit_result = {
                    let Ok(_event_guard) = crate::db::local_data_write_gate::lock_local_data_write(
                        Some(write_generation),
                    )
                    .await
                    else {
                        return Ok(());
                    };
                    if !is_connection_current(&state, receiver_generation, write_generation) {
                        return Ok(());
                    }
                    app.emit(EVT_REMOTE_FINAL_TEXT_RECEIVED, payload)
                };

                match emit_result {
                    Ok(()) => {
                        let delivered_at = chrono::Utc::now().to_rfc3339();
                        if !record_delivery_while_active(
                            &state,
                            receiver_generation,
                            write_generation,
                            RemoteReceiverEventDetails {
                                sender_device_id: Some(sender_device_id),
                                event_id: Some(event_id.clone()),
                                target_class_name: target_info.class_name.clone(),
                                target_title: target_info.title.clone(),
                                target_editable,
                            },
                            Some(delivered_at.clone()),
                        )
                        .await
                        {
                            return Ok(());
                        }
                        if !write_message_while_active(
                            &mut writer,
                            &OutgoingEnvelope::DeliveryAck {
                                session_id,
                                event_id,
                                sequence,
                                delivered_at,
                            },
                            &mut shutdown,
                            &state,
                            receiver_generation,
                            write_generation,
                        )
                        .await?
                        {
                            return Ok(());
                        }
                    }
                    Err(err) => {
                        let message = format!("Failed to emit remote transcript event: {err}");
                        if !record_error_while_active(
                            &state,
                            receiver_generation,
                            write_generation,
                            RemoteReceiverEventDetails {
                                sender_device_id: Some(sender_device_id),
                                event_id: Some(event_id.clone()),
                                target_class_name: target_info.class_name.clone(),
                                target_title: target_info.title.clone(),
                                target_editable,
                            },
                            message.clone(),
                        )
                        .await
                        {
                            return Ok(());
                        }
                        if !write_message_while_active(
                            &mut writer,
                            &OutgoingEnvelope::DeliveryError {
                                session_id,
                                event_id,
                                sequence,
                                code: "event_emit_failed".to_string(),
                                message,
                            },
                            &mut shutdown,
                            &state,
                            receiver_generation,
                            write_generation,
                        )
                        .await?
                        {
                            return Ok(());
                        }
                    }
                }
            }
            IncomingEnvelope::Heartbeat {
                session_id,
                sent_at: _sent_at,
            } => {
                if !write_message_while_active(
                    &mut writer,
                    &OutgoingEnvelope::SessionAck {
                        session_id,
                        receiver_device_id: state.status().device_id,
                    },
                    &mut shutdown,
                    &state,
                    receiver_generation,
                    write_generation,
                )
                .await?
                {
                    return Ok(());
                }
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
    let json = serde_json::to_string(message)
        .map_err(|err| format!("Failed to serialize receiver message: {err}"))?;
    writer
        .write_all(json.as_bytes())
        .await
        .map_err(|err| format!("Failed to write receiver message: {err}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|err| format!("Failed to finalize receiver message: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::wait_for_shutdown;
    use std::time::Duration;

    #[tokio::test]
    async fn shutdown_signal_releases_a_waiting_connection_task() {
        let (shutdown, mut receiver) = tokio::sync::watch::channel(false);
        let waiting = tokio::spawn(async move {
            wait_for_shutdown(&mut receiver).await;
        });

        shutdown.send(true).expect("receiver is still waiting");
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("shutdown interrupts the connection wait")
            .expect("wait task does not panic");
    }
}
