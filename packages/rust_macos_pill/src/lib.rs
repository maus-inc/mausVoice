#![allow(deprecated, unexpected_cfgs)]

#[macro_use]
extern crate objc;

pub mod ipc;

mod app;
mod constants;
mod draw;
mod font;
mod gfx;
mod input;
mod nsstring;
mod state;

use std::sync::mpsc::{Receiver, Sender};

use ipc::{InMessage, OutMessage};

/// Start the pill overlay in embedded (library) mode.
/// Must be called from the main thread (Cocoa requirement).
/// Returns immediately: the pill hooks into the existing NSApplication run loop.
///
/// `saved_position` is the record of where the pill was last parked, already
/// read by the host from its database. It is applied before the window is
/// placed, so the pill never appears in the default corner first.
pub fn start(
    out_sender: Sender<OutMessage>,
    in_receiver: Receiver<InMessage>,
    saved_position: Option<rust_pill_shared::restore::ParkedWindow>,
) {
    font::install_embedded_satoshi();
    ipc::set_out_sender(out_sender);
    app::run_embedded(in_receiver, saved_position);
}
