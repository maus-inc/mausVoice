use std::{future::Future, time::Duration};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;

use crate::{db::local_data_write_gate::LocalDataRemoteOperationGuard, state::RemoteReceiverState};

const REMOTE_IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutgoingEnvelope {
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
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IncomingEnvelope {
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

pub async fn pair_with_receiver(
    pool: SqlitePool,
    sender_state: RemoteReceiverState,
    receiver_device_id: &str,
    receiver_name: &str,
    receiver_platform: &str,
    receiver_address: &str,
    pairing_code: &str,
) -> Result<crate::domain::PairedRemoteDevice, String> {
    let operation = crate::db::local_data_write_gate::begin_local_data_remote_operation()
        .map_err(|err| err.to_string())?;
    let sender = sender_state.status();
    let request_id = generate_id("pair");
    let stream = await_remote_io(
        &operation,
        format!("Timed out connecting to remote receiver at {receiver_address}"),
        async {
            TcpStream::connect(receiver_address).await.map_err(|err| {
                format!("Failed to connect to remote receiver at {receiver_address}: {err}")
            })
        },
    )
    .await?;
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    send_message(
        &operation,
        &mut writer,
        &OutgoingEnvelope::PairingRequest {
            request_id: request_id.clone(),
            sender_device_id: sender.device_id.clone(),
            sender_device_name: sender.device_name.clone(),
            sender_platform: sender.device_platform.clone(),
            pairing_code: pairing_code.to_string(),
        },
        "Timed out sending remote pairing request.",
    )
    .await?;

    match read_message(&operation, &mut lines).await? {
        IncomingEnvelope::PairingAccept {
            request_id: ack_request_id,
            receiver_device_id: ack_receiver_device_id,
            receiver_device_name: ack_receiver_device_name,
            receiver_platform: ack_receiver_platform,
            shared_secret,
        } => {
            if ack_request_id != request_id {
                return Err("Remote receiver acknowledged the wrong pairing request.".to_string());
            }
            if ack_receiver_device_id != receiver_device_id {
                return Err(
                    "Connected receiver does not match the imported pairing code.".to_string(),
                );
            }

            let paired_at = chrono::Utc::now().to_rfc3339();
            let device = crate::domain::PairedRemoteDevice {
                id: ack_receiver_device_id,
                name: if ack_receiver_device_name.trim().is_empty() {
                    receiver_name.to_string()
                } else {
                    ack_receiver_device_name
                },
                platform: if ack_receiver_platform.trim().is_empty() {
                    receiver_platform.to_string()
                } else {
                    ack_receiver_platform
                },
                role: "receiver".to_string(),
                shared_secret,
                paired_at,
                last_seen_at: None,
                last_known_address: Some(receiver_address.to_string()),
                trusted: true,
            };

            // The remote handshake is complete. Take the native write mutex
            // through the operation lease so clear cancellation can interrupt
            // this wait instead of deadlocking while it drains remote work.
            let write_guard = operation
                .lock_local_data_write()
                .await
                .map_err(|err| err.to_string())?;
            crate::db::paired_remote_device_queries::upsert_paired_remote_device_unlocked(
                &write_guard,
                pool,
                &device,
            )
            .await
            .map_err(|err| format!("Failed to save paired receiver: {err}"))?;

            Ok(device)
        }
        IncomingEnvelope::DeliveryError { message, .. } => Err(message),
        IncomingEnvelope::SessionAck { .. } => {
            Err("Remote receiver returned an unexpected session ack.".to_string())
        }
        IncomingEnvelope::DeliveryAck { .. } => {
            Err("Remote receiver returned an unexpected delivery ack.".to_string())
        }
    }
}

pub async fn deliver_final_text(
    pool: SqlitePool,
    sender_state: RemoteReceiverState,
    target_device_id: &str,
    text: &str,
    mode: &str,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let operation = crate::db::local_data_write_gate::begin_local_data_remote_operation()
        .map_err(|err| err.to_string())?;
    let target = await_remote_io(
        &operation,
        "Timed out loading the paired remote receiver.".to_string(),
        async {
            crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
                pool,
                target_device_id,
            )
            .await
            .map_err(|err| format!("Failed to load target device: {err}"))
        },
    )
    .await?
    .ok_or_else(|| "Target device is not paired.".to_string())?;

    if !target.trusted {
        return Err("Target device is not trusted.".to_string());
    }

    let address = target
        .last_known_address
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Target device does not have a known receiver address.".to_string())?;

    let sender = sender_state.status();
    let session_id = generate_id("session");
    let event_id = generate_id("event");
    let stream = await_remote_io(
        &operation,
        format!("Timed out connecting to remote receiver at {address}"),
        async {
            TcpStream::connect(address.as_str())
                .await
                .map_err(|err| format!("Failed to connect to remote receiver at {address}: {err}"))
        },
    )
    .await?;
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    send_message(
        &operation,
        &mut writer,
        &OutgoingEnvelope::SessionHello {
            session_id: session_id.clone(),
            sender_device_id: sender.device_id,
            auth_token: target.shared_secret.clone(),
        },
        "Timed out sending remote session hello.",
    )
    .await?;

    let session_ack = read_message(&operation, &mut lines).await?;
    match session_ack {
        IncomingEnvelope::SessionAck {
            session_id: ack_session_id,
            receiver_device_id,
        } => {
            if ack_session_id != session_id {
                return Err("Remote receiver acknowledged the wrong session.".to_string());
            }
            if receiver_device_id != target.id {
                return Err("Connected receiver does not match the selected device.".to_string());
            }
        }
        IncomingEnvelope::DeliveryError { message, .. } => {
            return Err(message);
        }
        IncomingEnvelope::DeliveryAck { .. } => {
            return Err("Remote receiver returned an unexpected delivery ack.".to_string());
        }
        IncomingEnvelope::PairingAccept { .. } => {
            return Err("Remote receiver returned an unexpected pairing accept.".to_string());
        }
    }

    send_message(
        &operation,
        &mut writer,
        &OutgoingEnvelope::FinalText {
            session_id: session_id.clone(),
            event_id: event_id.clone(),
            sequence: 1,
            text: text.to_string(),
            mode: mode.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
        "Timed out sending remote transcript.",
    )
    .await?;

    match read_message(&operation, &mut lines).await? {
        IncomingEnvelope::DeliveryAck {
            session_id: ack_session_id,
            event_id: ack_event_id,
            sequence,
            delivered_at,
        } => {
            if ack_session_id != session_id || ack_event_id != event_id || sequence != 1 {
                return Err("Remote receiver acknowledged the wrong delivery.".to_string());
            }
            log::info!("Remote final text delivered at {delivered_at}");
            Ok(())
        }
        IncomingEnvelope::DeliveryError {
            session_id,
            event_id,
            sequence,
            code,
            message,
        } => Err(format!(
            "Remote delivery failed ({code}) for session {session_id}, event {event_id}, sequence {sequence}: {message}"
        )),
        IncomingEnvelope::SessionAck { .. } => {
            Err("Remote receiver returned an unexpected session ack.".to_string())
        }
        IncomingEnvelope::PairingAccept { .. } => {
            Err("Remote receiver returned an unexpected pairing accept.".to_string())
        }
    }
}

async fn await_remote_io<T>(
    operation: &LocalDataRemoteOperationGuard,
    timeout_message: String,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = operation.cancelled() => Err("Local data is being cleared".to_string()),
        result = tokio::time::timeout(REMOTE_IO_TIMEOUT, future) => {
            match result {
                Ok(Ok(value)) => {
                    operation.ensure_current().map_err(|err| err.to_string())?;
                    Ok(value)
                }
                Ok(Err(error)) => Err(error),
                Err(_) => Err(timeout_message),
            }
        }
    }
}

async fn send_message(
    operation: &LocalDataRemoteOperationGuard,
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    message: &OutgoingEnvelope,
    timeout_message: &str,
) -> Result<(), String> {
    // Hold the clear handoff lock only for this bounded write, never for the
    // connection, handshake response, or delivery acknowledgement.
    let _handoff = operation
        .lock_message_handoff()
        .await
        .map_err(|err| err.to_string())?;
    await_remote_io(
        operation,
        timeout_message.to_string(),
        write_message(writer, message),
    )
    .await
}

async fn read_message(
    operation: &LocalDataRemoteOperationGuard,
    lines: &mut tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
) -> Result<IncomingEnvelope, String> {
    await_remote_io(
        operation,
        "Timed out waiting for remote receiver response.".to_string(),
        async {
            let line = lines
                .next_line()
                .await
                .map_err(|err| format!("Failed to read remote receiver response: {err}"))?
                .ok_or_else(|| "Remote receiver closed the connection.".to_string())?;

            serde_json::from_str(&line)
                .map_err(|err| format!("Failed to parse remote receiver response: {err}"))
        },
    )
    .await
}

async fn write_message(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    message: &OutgoingEnvelope,
) -> Result<(), String> {
    super::remote_channel::write_json_message(writer, message, "remote sender").await
}

fn generate_id(prefix: &str) -> String {
    format!("{prefix}-{:08x}", rand::random::<u32>())
}
