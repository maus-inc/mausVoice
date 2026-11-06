use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::io::BufReader;

use super::remote_protocol::{read_frame, trusted_for, write_frame, DeviceRole};
use tokio::net::TcpStream;

use crate::state::RemoteReceiverState;

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
    let sender = sender_state.status();
    let request_id = generate_id("pair");
    let stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(receiver_address))
        .await
        .map_err(|_| format!("Timed out connecting to remote receiver at {receiver_address}"))?
        .map_err(|err| {
            format!("Failed to connect to remote receiver at {receiver_address}: {err}")
        })?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    write_message(
        &mut writer,
        &OutgoingEnvelope::PairingRequest {
            request_id: request_id.clone(),
            sender_device_id: sender.device_id.clone(),
            sender_device_name: sender.device_name.clone(),
            sender_platform: sender.device_platform.clone(),
            pairing_code: pairing_code.to_string(),
        },
    )
    .await?;

    match read_message(&mut reader).await? {
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
            if shared_secret.trim().is_empty() {
                return Err("Remote receiver supplied an empty pairing secret.".to_string());
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

            crate::db::paired_remote_device_queries::upsert_paired_remote_device(pool, &device)
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

/// Recheck the same pairing before disclosing a secret or transcript. A user
/// can revoke, replace, or redirect a target while network setup is in flight.
async fn ensure_current_receiver(
    pool: &SqlitePool,
    original: &crate::domain::PairedRemoteDevice,
) -> Result<(), String> {
    let current = crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
        pool.clone(),
        &original.id,
    )
    .await
    .map_err(|err| format!("Failed to validate target device: {err}"))?;
    if !current.is_some_and(|current| {
        trusted_for(&current, DeviceRole::Receiver)
            && current.shared_secret == original.shared_secret
            && current.last_known_address == original.last_known_address
            && current.paired_at == original.paired_at
    }) {
        return Err("Target device pairing changed before delivery.".to_string());
    }
    Ok(())
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

    let target = crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
        pool.clone(),
        target_device_id,
    )
    .await
    .map_err(|err| format!("Failed to load target device: {err}"))?
    .ok_or_else(|| "Target device is not paired.".to_string())?;

    if !trusted_for(&target, DeviceRole::Receiver) {
        return Err("Target device is not a trusted receiver.".to_string());
    }

    let address = target
        .last_known_address
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Target device does not have a known receiver address.".to_string())?;

    let sender = sender_state.status();
    let session_id = generate_id("session");
    let event_id = generate_id("event");
    let stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(address.as_str()))
        .await
        .map_err(|_| format!("Timed out connecting to remote receiver at {address}"))?
        .map_err(|err| format!("Failed to connect to remote receiver at {address}: {err}"))?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    ensure_current_receiver(&pool, &target).await?;
    write_message(
        &mut writer,
        &OutgoingEnvelope::SessionHello {
            session_id: session_id.clone(),
            sender_device_id: sender.device_id,
            auth_token: target.shared_secret.clone(),
        },
    )
    .await?;

    match read_message(&mut reader).await? {
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

    // A session acknowledgement can arrive long after the initial check.
    // Do not send text using a pairing that was revoked in the meantime.
    ensure_current_receiver(&pool, &target).await?;
    write_message(
        &mut writer,
        &OutgoingEnvelope::FinalText {
            session_id: session_id.clone(),
            event_id: event_id.clone(),
            sequence: 1,
            text: text.to_string(),
            mode: mode.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    )
    .await?;

    match read_message(&mut reader).await? {
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

async fn read_message(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> Result<IncomingEnvelope, String> {
    let line = tokio::time::timeout(Duration::from_secs(5), read_frame(reader))
        .await
        .map_err(|_| "Timed out waiting for remote receiver response.".to_string())?
        .map_err(|err| format!("Failed to read remote receiver response: {err}"))?
        .ok_or_else(|| "Remote receiver closed the connection.".to_string())?;
    serde_json::from_str(&line)
        .map_err(|err| format!("Failed to parse remote receiver response: {err}"))
}

async fn write_message(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    message: &OutgoingEnvelope,
) -> Result<(), String> {
    write_frame(writer, message)
        .await
        .map_err(|err| format!("Failed to write remote sender message: {err}"))
}

fn generate_id(prefix: &str) -> String {
    // These are opaque protocol IDs. Thirty-two random bits collide readily
    // over a device's lifetime, particularly with realtime segment delivery.
    format!("{prefix}-{:032x}", rand::random::<u128>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn test_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE paired_remote_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, role TEXT NOT NULL, shared_secret TEXT NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT, last_known_address TEXT, trusted INTEGER NOT NULL)")
            .execute(&pool).await.unwrap();
        pool
    }

    fn receiver(address: String) -> crate::domain::PairedRemoteDevice {
        crate::domain::PairedRemoteDevice {
            id: "receiver".into(),
            name: "receiver".into(),
            platform: "windows".into(),
            role: "both".into(),
            shared_secret: "secret".into(),
            paired_at: "original".into(),
            last_seen_at: None,
            last_known_address: Some(address),
            trusted: true,
        }
    }

    #[test]
    fn generated_protocol_ids_have_a_full_128_bit_random_suffix() {
        let id = generate_id("event");
        let suffix = id.strip_prefix("event-").unwrap();
        assert_eq!(suffix.len(), 32);
        assert!(suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn pairing_refuses_an_empty_secret_without_persisting_trust() {
        for secret in ["", "   "] {
            let pool = test_pool().await;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap().to_string();
            let pairing = {
                let pool = pool.clone();
                tokio::spawn(async move {
                    pair_with_receiver(
                        pool,
                        RemoteReceiverState::new(),
                        "receiver",
                        "Receiver",
                        "windows",
                        &address,
                        "code",
                    )
                    .await
                })
            };
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut read = BufReader::new(read);
            let request: serde_json::Value =
                serde_json::from_str(&read_frame(&mut read).await.unwrap().unwrap()).unwrap();
            write_frame(
                &mut write,
                &serde_json::json!({
                    "type": "pairing_accept", "request_id": request["request_id"],
                    "receiver_device_id": "receiver", "receiver_device_name": "Receiver",
                    "receiver_platform": "windows", "shared_secret": secret,
                }),
            )
            .await
            .unwrap();
            assert!(pairing.await.unwrap().is_err());
            assert!(
                crate::db::paired_remote_device_queries::fetch_paired_remote_device_by_id(
                    pool, "receiver"
                )
                .await
                .unwrap()
                .is_none()
            );
        }
    }

    #[tokio::test]
    async fn receiver_revalidation_allows_non_security_metadata_changes() {
        let pool = test_pool().await;
        let target = receiver("127.0.0.1:1234".into());
        crate::db::paired_remote_device_queries::upsert_paired_remote_device(pool.clone(), &target)
            .await
            .unwrap();
        sqlx::query("UPDATE paired_remote_devices SET name = 'renamed', platform = 'macos', role = 'receiver', last_seen_at = 'later'")
            .execute(&pool).await.unwrap();
        assert!(ensure_current_receiver(&pool, &target).await.is_ok());
    }

    #[tokio::test]
    async fn receiver_revalidation_rejects_revoked_replaced_or_redirected_records() {
        let pool = test_pool().await;
        let target = receiver("127.0.0.1:1234".into());
        for mutation in [
            "UPDATE paired_remote_devices SET trusted = 0",
            "UPDATE paired_remote_devices SET role = 'sender'",
            "UPDATE paired_remote_devices SET shared_secret = 'replacement'",
            "UPDATE paired_remote_devices SET last_known_address = '127.0.0.1:5678'",
            "UPDATE paired_remote_devices SET paired_at = 'replacement'",
            "DELETE FROM paired_remote_devices",
        ] {
            crate::db::paired_remote_device_queries::upsert_paired_remote_device(
                pool.clone(),
                &target,
            )
            .await
            .unwrap();
            assert!(ensure_current_receiver(&pool, &target).await.is_ok());
            sqlx::query(mutation).execute(&pool).await.unwrap();
            assert!(
                ensure_current_receiver(&pool, &target).await.is_err(),
                "{mutation}"
            );
        }
    }

    async fn exercise_delivery(revoke: bool) {
        let pool = test_pool().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = receiver(listener.local_addr().unwrap().to_string());
        crate::db::paired_remote_device_queries::upsert_paired_remote_device(pool.clone(), &target)
            .await
            .unwrap();
        let task = {
            let pool = pool.clone();
            tokio::spawn(async move {
                deliver_final_text(
                    pool,
                    RemoteReceiverState::new(),
                    "receiver",
                    "private transcript",
                    "dictation",
                )
                .await
            })
        };
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut read = BufReader::new(read);
        let hello: serde_json::Value =
            serde_json::from_str(&read_frame(&mut read).await.unwrap().unwrap()).unwrap();
        let session = hello["session_id"].as_str().unwrap();
        assert_eq!(hello["type"], "session_hello");
        if revoke {
            sqlx::query("UPDATE paired_remote_devices SET trusted = 0 WHERE id = 'receiver'")
                .execute(&pool)
                .await
                .unwrap();
        }
        write_frame(
            &mut write,
            &serde_json::json!({
                "type": "session_ack", "session_id": session, "receiver_device_id": "receiver"
            }),
        )
        .await
        .unwrap();
        let next = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut read))
            .await
            .unwrap()
            .unwrap();
        if revoke {
            assert!(next.is_none(), "revoked receiver got transcript data");
            assert!(task.await.unwrap().is_err());
        } else {
            let message: serde_json::Value = serde_json::from_str(&next.unwrap()).unwrap();
            assert_eq!(message["text"], "private transcript");
            write_frame(
                &mut write,
                &serde_json::json!({
                    "type": "delivery_ack", "session_id": session,
                    "event_id": message["event_id"], "sequence": 1, "delivered_at": "now"
                }),
            )
            .await
            .unwrap();
            task.await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn revoking_trust_during_handshake_prevents_transcript_delivery() {
        exercise_delivery(true).await;
    }

    #[tokio::test]
    async fn unchanged_bidirectional_receiver_can_receive_a_transcript() {
        exercise_delivery(false).await;
    }
}
