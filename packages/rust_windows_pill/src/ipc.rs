use std::io::{self, Write};

pub use rust_pill_shared::schema::*;

/// Send one message to the desktop process over stdout.
///
/// Returns whether the bytes were actually handed to the pipe. A write to a
/// desktop process that has exited fails, and callers that would otherwise
/// discard the user's text — the entry clearing itself on submit — need that
/// to decide whether the message really landed. This used to discard every
/// error with `let _ =`, which is why this pill was the only one of the three
/// that threw the entry away on a failed write.
pub fn send(msg: &OutMessage) -> bool {
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, msg).is_err() {
        return false;
    }
    if stdout.write_all(b"\n").is_err() {
        return false;
    }
    stdout.flush().is_ok()
}
