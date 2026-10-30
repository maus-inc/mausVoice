use serde::Serialize;
use tokio::io::AsyncWriteExt;

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
