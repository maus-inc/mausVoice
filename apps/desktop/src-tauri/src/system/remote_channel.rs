//! The wire between a companion sender and the desktop receiver.
//!
//! Both sides used to declare their own copy of these envelopes, so a field
//! renamed on one side still compiled and only failed once two real devices
//! talked to each other. Each direction is now defined once, here, and the two
//! sides import the messages they write and the ones they read.

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

/// Messages a companion sender writes and the desktop receiver reads.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum SenderMessage {
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

/// Messages the desktop receiver writes and a companion sender reads.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ReceiverMessage {
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

/// Write one newline-delimited JSON message to a remote channel.
///
/// The receiver and the sender share this framing so a message written on one
/// side is always readable on the other, and so a failure names the direction
/// that failed without repeating the write sequence in both files.
pub(crate) async fn write_json_message<T: Serialize>(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    message: &T,
    direction: &str,
) -> Result<(), String> {
    let json = serde_json::to_string(message)
        .map_err(|err| format!("Failed to serialize {direction} message: {err}"))?;
    writer
        .write_all(json.as_bytes())
        .await
        .map_err(|err| format!("Failed to write {direction} message: {err}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|err| format!("Failed to finalize {direction} message: {err}"))
}

#[cfg(test)]
mod tests {
    use super::{write_json_message, ReceiverMessage, SenderMessage};
    use serde::Serialize;
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, BufReader};

    fn sender_messages() -> Vec<SenderMessage> {
        vec![
            SenderMessage::PairingRequest {
                request_id: "pair-1".to_string(),
                sender_device_id: "phone-1".to_string(),
                sender_device_name: "Phone".to_string(),
                sender_platform: "android".to_string(),
                pairing_code: "123456".to_string(),
            },
            SenderMessage::SessionHello {
                session_id: "session-1".to_string(),
                sender_device_id: "phone-1".to_string(),
                auth_token: "shared-secret".to_string(),
            },
            SenderMessage::FinalText {
                session_id: "session-1".to_string(),
                event_id: "event-1".to_string(),
                sequence: 7,
                text: "hello".to_string(),
                mode: "dictate".to_string(),
                created_at: "2026-01-02T12:00:00Z".to_string(),
            },
            SenderMessage::Heartbeat {
                session_id: "session-1".to_string(),
                sent_at: "2026-01-02T12:00:05Z".to_string(),
            },
        ]
    }

    fn receiver_messages() -> Vec<ReceiverMessage> {
        vec![
            ReceiverMessage::PairingAccept {
                request_id: "pair-1".to_string(),
                receiver_device_id: "desktop-1".to_string(),
                receiver_device_name: "Desktop".to_string(),
                receiver_platform: "macos".to_string(),
                shared_secret: "shared-secret".to_string(),
            },
            ReceiverMessage::SessionAck {
                session_id: "session-1".to_string(),
                receiver_device_id: "desktop-1".to_string(),
            },
            ReceiverMessage::DeliveryAck {
                session_id: "session-1".to_string(),
                event_id: "event-1".to_string(),
                sequence: 7,
                delivered_at: "2026-01-02T12:00:00Z".to_string(),
            },
            ReceiverMessage::DeliveryError {
                session_id: "session-1".to_string(),
                event_id: String::new(),
                sequence: 0,
                code: "unauthorized".to_string(),
                message: "Sender authentication failed.".to_string(),
            },
        ]
    }

    fn type_tag<T: Serialize>(message: &T) -> String {
        let value = serde_json::to_value(message).expect("serialize a test message");
        value
            .get("type")
            .and_then(Value::as_str)
            .expect("every message carries a type tag")
            .to_string()
    }

    #[test]
    fn messages_round_trip_through_the_shared_definition() {
        for message in sender_messages() {
            let json = serde_json::to_string(&message).expect("serialize a sender message");
            let decoded: SenderMessage =
                serde_json::from_str(&json).expect("deserialize a sender message");
            assert_eq!(decoded, message);
        }

        for message in receiver_messages() {
            let json = serde_json::to_string(&message).expect("serialize a receiver message");
            let decoded: ReceiverMessage =
                serde_json::from_str(&json).expect("deserialize a receiver message");
            assert_eq!(decoded, message);
        }
    }

    #[test]
    fn every_message_kind_keeps_its_snake_case_type_tag() {
        let sender_tags: Vec<String> = sender_messages().iter().map(type_tag).collect();
        assert_eq!(
            sender_tags,
            vec![
                "pairing_request".to_string(),
                "session_hello".to_string(),
                "final_text".to_string(),
                "heartbeat".to_string(),
            ]
        );

        let receiver_tags: Vec<String> = receiver_messages().iter().map(type_tag).collect();
        assert_eq!(
            receiver_tags,
            vec![
                "pairing_accept".to_string(),
                "session_ack".to_string(),
                "delivery_ack".to_string(),
                "delivery_error".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn written_messages_arrive_one_per_line() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind a loopback listener");
        let address = listener.local_addr().expect("read the listener address");
        let client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect to the listener");
        let (peer, _) = listener.accept().await.expect("accept the connection");

        let (_, mut writer) = client.into_split();
        let (peer_reader, _) = peer.into_split();
        let mut lines = BufReader::new(peer_reader).lines();

        let first = SenderMessage::SessionHello {
            session_id: "session-1".to_string(),
            sender_device_id: "phone-1".to_string(),
            auth_token: "shared-secret".to_string(),
        };
        let second = SenderMessage::Heartbeat {
            session_id: "session-1".to_string(),
            sent_at: "2026-01-02T12:00:05Z".to_string(),
        };

        write_json_message(&mut writer, &first, "remote sender")
            .await
            .expect("write the first message");
        write_json_message(&mut writer, &second, "remote sender")
            .await
            .expect("write the second message");

        let first_line = lines
            .next_line()
            .await
            .expect("read the first line")
            .expect("the first line arrives");
        let decoded_first: SenderMessage =
            serde_json::from_str(&first_line).expect("parse the first message");
        assert_eq!(decoded_first, first);

        let second_line = lines
            .next_line()
            .await
            .expect("read the second line")
            .expect("the second line arrives");
        let decoded_second: SenderMessage =
            serde_json::from_str(&second_line).expect("parse the second message");
        assert_eq!(decoded_second, second);
    }
}
