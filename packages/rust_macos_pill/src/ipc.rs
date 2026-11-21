use std::cell::RefCell;
use std::sync::mpsc::Sender;

thread_local! {
    static OUT_SENDER: RefCell<Option<Sender<OutMessage>>> = const { RefCell::new(None) };
}

#[allow(dead_code)]
pub fn set_out_sender(sender: Sender<OutMessage>) {
    OUT_SENDER.with(|cell| *cell.borrow_mut() = Some(sender));
}

pub use rust_pill_shared::messages::*;

pub fn send(msg: &OutMessage) -> bool {
    let sent_via_channel = OUT_SENDER.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|s| s.send(msg.clone()).is_ok())
            .unwrap_or(false)
    });
    sent_via_channel || rust_pill_shared::messages::write_message(msg)
}
