use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sqlx::SqlitePool;
use std::net::UdpSocket;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::remote_channel::{ReceiverMessage, SenderMessage};
use crate::state::{RemoteReceiverEventDetails, RemoteReceiverState, RemoteReceiverStatus};

pub const EVT_REMOTE_FINAL_TEXT_RECEIVED: &str = "remote_final_text_received";

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
    message: &ReceiverMessage,
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
    state.record_error_for_generation(receiver_generation, details, message)
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
    state.record_delivery_for_generation(receiver_generation, details, delivered_at)
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

/// Why a sender was turned away.
///
/// The code and message travel to the companion app, which shows them to the
/// person holding the phone, so they are part of the wire contract rather than
/// free-form logging text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SenderRejection {
    NotPaired,
    Unauthorized,
}

impl SenderRejection {
    fn code(self) -> &'static str {
        match self {
            Self::NotPaired => "unknown_sender",
            Self::Unauthorized => "unauthorized",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::NotPaired => "Sender is not paired.",
            Self::Unauthorized => "Sender authentication failed.",
        }
    }
}

/// Build the delivery error a rejected sender receives.
fn rejection_message(session_id: String, rejection: SenderRejection) -> ReceiverMessage {
    ReceiverMessage::DeliveryError {
        session_id,
        event_id: String::new(),
        sequence: 0,
        code: rejection.code().to_string(),
        message: rejection.message().to_string(),
    }
}

struct ConnectionMessageHandler<'a> {
    pool: &'a SqlitePool,
    state: &'a RemoteReceiverState,
    app: &'a AppHandle,
    write_generation: u64,
    receiver_generation: u64,
    writer: &'a mut tokio::net::tcp::OwnedWriteHalf,
    shutdown: &'a mut watch::Receiver<bool>,
    authenticated_sender: &'a mut Option<String>,
}

impl ConnectionMessageHandler<'_> {
    async fn handle(&mut self, envelope: SenderMessage) -> Result<bool, String> {
        match envelope {
            SenderMessage::PairingRequest {
                request_id,
                sender_device_id,
                sender_device_name,
                sender_platform,
                pairing_code,
            } => {
                self.handle_pairing_request(
                    request_id,
                    sender_device_id,
                    sender_device_name,
                    sender_platform,
                    pairing_code,
                )
                .await
            }
            SenderMessage::SessionHello {
                session_id,
                sender_device_id,
                auth_token,
            } => {
                self.handle_session_hello(session_id, sender_device_id, auth_token)
                    .await
            }
            SenderMessage::FinalText {
                session_id,
                event_id,
                sequence,
                text,
                mode,
                created_at,
            } => {
                self.handle_final_text(session_id, event_id, sequence, text, mode, created_at)
                    .await
            }
            SenderMessage::Heartbeat {
                session_id,
                sent_at,
            } => self.handle_heartbeat(session_id, sent_at).await,
        }
    }

    async fn handle_pairing_request(
        &mut self,
        request_id: String,
        sender_device_id: String,
        sender_device_name: String,
        sender_platform: String,
        pairing_code: String,
    ) -> Result<bool, String> {
        if pairing_code != self.state.status().pairing_code {
            let message = "Pairing code is invalid.".to_string();
            if !record_error_while_active(
                self.state,
                self.receiver_generation,
                self.write_generation,
                RemoteReceiverEventDetails {
                    sender_device_id: Some(sender_device_id),
                    ..RemoteReceiverEventDetails::default()
                },
                message.clone(),
            )
            .await
            {
                return Ok(false);
            }
            return write_message_while_active(
                self.writer,
                &ReceiverMessage::DeliveryError {
                    session_id: String::new(),
                    event_id: String::new(),
                    sequence: 0,
                    code: "invalid_pairing_code".to_string(),
                    message,
                },
                self.shutdown,
                self.state,
                self.receiver_generation,
                self.write_generation,
            )
            .await;
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

        if !is_connection_current(self.state, self.receiver_generation, self.write_generation) {
            return Ok(false);
        }
        if let Err(error) =
            crate::db::paired_remote_device_queries::upsert_paired_remote_device_for_generation(
                (*self.pool).clone(),
                &sender_device,
                self.write_generation,
            )
            .await
        {
            if !is_connection_current(self.state, self.receiver_generation, self.write_generation) {
                return Ok(false);
            }
            return Err(format!("Failed to store paired sender: {error}"));
        }
        if !is_connection_current(self.state, self.receiver_generation, self.write_generation)
            || !rotate_pairing_code_while_active(
                self.state,
                self.receiver_generation,
                self.write_generation,
            )
            .await
        {
            return Ok(false);
        }

        let receiver_status = self.state.status();
        write_message_while_active(
            self.writer,
            &ReceiverMessage::PairingAccept {
                request_id,
                receiver_device_id: receiver_status.device_id,
                receiver_device_name: receiver_status.device_name,
                receiver_platform: receiver_status.device_platform,
                shared_secret,
            },
            self.shutdown,
            self.state,
            self.receiver_generation,
            self.write_generation,
        )
        .await
    }

    /// Turn away a sender that did not authenticate, recording the reason on
    /// the receiver status and answering with the matching delivery error.
    async fn reject_sender(
        &mut self,
        session_id: String,
        sender_device_id: &str,
        rejection: SenderRejection,
    ) -> Result<bool, String> {
        if !record_error_while_active(
            self.state,
            self.receiver_generation,
            self.write_generation,
            RemoteReceiverEventDetails {
                sender_device_id: Some(sender_device_id.to_string()),
                ..RemoteReceiverEventDetails::default()
            },
            rejection.message().to_string(),
        )
        .await
        {
            return Ok(false);
        }

        write_message_while_active(
            self.writer,
            &rejection_message(session_id, rejection),
            self.shutdown,
            self.state,
            self.receiver_generation,
            self.write_generation,
        )
        .await
    }

    async fn handle_session_hello(
        &mut self,
        session_id: String,
        sender_device_id: String,
        auth_token: String,
    ) -> Result<bool, String> {
        let device_result =
            crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
                (*self.pool).clone(),
                &sender_device_id,
            )
            .await;
        if !is_connection_current(self.state, self.receiver_generation, self.write_generation) {
            return Ok(false);
        }
        let device =
            device_result.map_err(|error| format!("Failed to validate sender device: {error}"))?;

        match device {
            Some(device) if device.trusted && device.shared_secret == auth_token => {}
            Some(_) => {
                return self
                    .reject_sender(session_id, &sender_device_id, SenderRejection::Unauthorized)
                    .await
            }
            None => {
                return self
                    .reject_sender(session_id, &sender_device_id, SenderRejection::NotPaired)
                    .await
            }
        };

        if !is_connection_current(self.state, self.receiver_generation, self.write_generation) {
            return Ok(false);
        }
        *self.authenticated_sender = Some(sender_device_id);
        write_message_while_active(
            self.writer,
            &ReceiverMessage::SessionAck {
                session_id,
                receiver_device_id: self.state.status().device_id,
            },
            self.shutdown,
            self.state,
            self.receiver_generation,
            self.write_generation,
        )
        .await
    }

    async fn handle_final_text(
        &mut self,
        session_id: String,
        event_id: String,
        sequence: u64,
        text: String,
        mode: String,
        created_at: String,
    ) -> Result<bool, String> {
        let Some(sender_device_id) = self.authenticated_sender.clone() else {
            if !record_error_while_active(
                self.state,
                self.receiver_generation,
                self.write_generation,
                RemoteReceiverEventDetails {
                    event_id: Some(event_id.clone()),
                    ..RemoteReceiverEventDetails::default()
                },
                "No authenticated sender session.".to_string(),
            )
            .await
            {
                return Ok(false);
            }
            return write_message_while_active(
                self.writer,
                &ReceiverMessage::DeliveryError {
                    session_id,
                    event_id,
                    sequence,
                    code: "unauthorized".to_string(),
                    message: "No authenticated sender session.".to_string(),
                },
                self.shutdown,
                self.state,
                self.receiver_generation,
                self.write_generation,
            )
            .await;
        };

        if mode == "test" {
            let delivered_at = chrono::Utc::now().to_rfc3339();
            if !record_delivery_while_active(
                self.state,
                self.receiver_generation,
                self.write_generation,
                RemoteReceiverEventDetails {
                    sender_device_id: Some(sender_device_id),
                    event_id: Some(event_id.clone()),
                    ..RemoteReceiverEventDetails::default()
                },
                Some(delivered_at.clone()),
            )
            .await
            {
                return Ok(false);
            }
            return write_message_while_active(
                self.writer,
                &ReceiverMessage::DeliveryAck {
                    session_id,
                    event_id,
                    sequence,
                    delivered_at,
                },
                self.shutdown,
                self.state,
                self.receiver_generation,
                self.write_generation,
            )
            .await;
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
            let Ok(_event_guard) = crate::db::local_data_write_gate::lock_local_data_write(Some(
                self.write_generation,
            ))
            .await
            else {
                return Ok(false);
            };
            if !is_connection_current(self.state, self.receiver_generation, self.write_generation) {
                return Ok(false);
            }
            self.app.emit(EVT_REMOTE_FINAL_TEXT_RECEIVED, payload)
        };

        match emit_result {
            Ok(()) => {
                let delivered_at = chrono::Utc::now().to_rfc3339();
                if !record_delivery_while_active(
                    self.state,
                    self.receiver_generation,
                    self.write_generation,
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
                    return Ok(false);
                }
                write_message_while_active(
                    self.writer,
                    &ReceiverMessage::DeliveryAck {
                        session_id,
                        event_id,
                        sequence,
                        delivered_at,
                    },
                    self.shutdown,
                    self.state,
                    self.receiver_generation,
                    self.write_generation,
                )
                .await
            }
            Err(error) => {
                let message = format!("Failed to emit remote transcript event: {error}");
                if !record_error_while_active(
                    self.state,
                    self.receiver_generation,
                    self.write_generation,
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
                    return Ok(false);
                }
                write_message_while_active(
                    self.writer,
                    &ReceiverMessage::DeliveryError {
                        session_id,
                        event_id,
                        sequence,
                        code: "event_emit_failed".to_string(),
                        message,
                    },
                    self.shutdown,
                    self.state,
                    self.receiver_generation,
                    self.write_generation,
                )
                .await
            }
        }
    }

    async fn handle_heartbeat(
        &mut self,
        session_id: String,
        _sent_at: String,
    ) -> Result<bool, String> {
        write_message_while_active(
            self.writer,
            &ReceiverMessage::SessionAck {
                session_id,
                receiver_device_id: self.state.status().device_id,
            },
            self.shutdown,
            self.state,
            self.receiver_generation,
            self.write_generation,
        )
        .await
    }
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
        let envelope: SenderMessage = serde_json::from_str(&line)
            .map_err(|err| format!("Failed to parse receiver message: {err}"))?;
        if !is_connection_current(&state, receiver_generation, write_generation) {
            return Ok(());
        }

        let keep_connection_active = {
            let mut handler = ConnectionMessageHandler {
                pool: &pool,
                state: &state,
                app: &app,
                write_generation,
                receiver_generation,
                writer: &mut writer,
                shutdown: &mut shutdown,
                authenticated_sender: &mut authenticated_sender,
            };
            handler.handle(envelope).await?
        };
        if !keep_connection_active {
            return Ok(());
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
    message: &ReceiverMessage,
) -> Result<(), String> {
    super::remote_channel::write_json_message(writer, message, "receiver").await
}

#[cfg(test)]
mod tests {
    use super::{rejection_message, wait_for_shutdown, SenderRejection};
    use crate::system::remote_channel::ReceiverMessage;
    use std::time::Duration;

    #[test]
    fn rejected_senders_get_the_code_and_text_the_companion_app_shows() {
        assert_eq!(SenderRejection::NotPaired.code(), "unknown_sender");
        assert_eq!(
            SenderRejection::NotPaired.message(),
            "Sender is not paired."
        );
        assert_eq!(SenderRejection::Unauthorized.code(), "unauthorized");
        assert_eq!(
            SenderRejection::Unauthorized.message(),
            "Sender authentication failed."
        );
    }

    #[test]
    fn a_rejection_carries_no_event_identity_so_the_sender_can_retry() {
        assert_eq!(
            rejection_message("session-1".to_string(), SenderRejection::Unauthorized),
            ReceiverMessage::DeliveryError {
                session_id: "session-1".to_string(),
                event_id: String::new(),
                sequence: 0,
                code: "unauthorized".to_string(),
                message: "Sender authentication failed.".to_string(),
            }
        );
    }

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
