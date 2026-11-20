use std::cell::RefCell;
use std::io::{self, Write};
use std::sync::mpsc::Sender;

pub use rust_pill_shared::schema::*;

thread_local! {
    static OUT_SENDER: RefCell<Option<Sender<OutMessage>>> = const { RefCell::new(None) };
}

/// Routes `send` through a channel when the desktop embeds the pill in-process.
///
/// The standalone binary leaves this unset and writes to stdout, so one `send`
/// serves both the embedded library and the child-process build.
#[allow(dead_code)]
pub fn set_out_sender(sender: Sender<OutMessage>) {
    OUT_SENDER.with(|cell| *cell.borrow_mut() = Some(sender));
}

pub fn send(msg: &OutMessage) -> bool {
    let sent_via_channel = OUT_SENDER.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|s| s.send(msg.clone()).is_ok())
            .unwrap_or(false)
    });
    if sent_via_channel {
        return true;
    }
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, msg).is_err() {
        return false;
    }
    if stdout.write_all(b"\n").is_err() {
        return false;
    }
    stdout.flush().is_ok()
}
