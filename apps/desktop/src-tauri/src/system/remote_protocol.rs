use std::io;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
pub enum DeviceRole {
    Sender,
    Receiver,
}

/// Compare a pairing secret without stopping at the first differing byte.
///
/// A remote peer sends this token, so a short-circuiting `==` tells the peer how
/// much of its guess matched. The length check still returns early, which is
/// fine because every generated secret is the same fixed width. An empty secret
/// never matches, even against another empty one.
pub fn secret_matches(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    if expected.is_empty() || expected.len() != provided.len() {
        return false;
    }
    let difference = expected
        .iter()
        .zip(provided)
        .fold(0u8, |acc, (left, right)| acc | (left ^ right));
    difference == 0
}

pub fn trusted_for(device: &crate::domain::PairedRemoteDevice, role: DeviceRole) -> bool {
    device.trusted
        && !device.shared_secret.trim().is_empty()
        && match role {
            DeviceRole::Sender => matches!(device.role.as_str(), "sender" | "both"),
            DeviceRole::Receiver => matches!(device.role.as_str(), "receiver" | "both"),
        }
}

pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await?;
    if read == 0 {
        return Ok(None);
    }
    if bytes.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Remote frame is too large or incomplete",
        ));
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Remote frame is not UTF-8"))
}

pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    message: &T,
) -> io::Result<()> {
    let json = serde_json::to_vec(message).map_err(io::Error::other)?;
    if json.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Remote frame is too large",
        ));
    }
    tokio::time::timeout(WRITE_TIMEOUT, async {
        writer.write_all(&json).await?;
        writer.write_all(b"\n").await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Remote write timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, BufReader};

    #[test]
    fn device_roles_respect_bidirectional_and_untrusted_records() {
        let mut device = crate::domain::PairedRemoteDevice {
            id: "device".into(),
            name: "device".into(),
            platform: "windows".into(),
            role: "sender".into(),
            shared_secret: "secret".into(),
            paired_at: "now".into(),
            last_seen_at: None,
            last_known_address: None,
            trusted: true,
        };
        for (role, sender, receiver) in [
            ("sender", true, false),
            ("receiver", false, true),
            ("both", true, true),
            ("unknown", false, false),
        ] {
            device.role = role.into();
            assert_eq!(trusted_for(&device, DeviceRole::Sender), sender);
            assert_eq!(trusted_for(&device, DeviceRole::Receiver), receiver);
        }
        device.role = "both".into();
        device.trusted = false;
        assert!(!trusted_for(&device, DeviceRole::Sender));
        assert!(!trusted_for(&device, DeviceRole::Receiver));
        device.trusted = true;
        for secret in ["", "  \t"] {
            device.shared_secret = secret.into();
            assert!(!trusted_for(&device, DeviceRole::Sender));
            assert!(!trusted_for(&device, DeviceRole::Receiver));
        }
    }

    #[test]
    fn compares_pairing_secrets_without_short_circuiting() {
        assert!(secret_matches("0f1e2d", "0f1e2d"));
        assert!(!secret_matches("0f1e2d", "0f1e2c"));
        assert!(!secret_matches("0f1e2d", "ff1e2d"));
        assert!(!secret_matches("0f1e2d", "0f1e2"));
        assert!(!secret_matches("0f1e2d", "0f1e2dd"));
        assert!(!secret_matches("", "0f1e2d"));
        assert!(!secret_matches("", ""));
    }

    #[tokio::test]
    async fn reads_multiple_frames_and_clean_eof() {
        let input = &b"first\nsecond\r\n"[..];
        let mut reader = BufReader::new(input);
        assert_eq!(
            read_frame(&mut reader).await.unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap().as_deref(),
            Some("second")
        );
        assert!(read_frame(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_unterminated_oversized_and_invalid_frames() {
        let mut reader = BufReader::new(&b"unfinished"[..]);
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let large = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut reader = BufReader::new(large.as_slice());
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let mut reader = BufReader::new(&b"\xff\n"[..]);
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn writes_json_frames_and_rejects_oversized_output() {
        let (mut writer, reader) = tokio::io::duplex(128);
        write_frame(&mut writer, &"hello").await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_frame(&mut reader).await.unwrap().as_deref(),
            Some("\"hello\"")
        );
        let large = "x".repeat(MAX_FRAME_BYTES);
        assert_eq!(
            write_frame(&mut writer, &large).await.unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        writer.shutdown().await.unwrap();
    }
}
