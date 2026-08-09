#![allow(deprecated, unexpected_cfgs)]

#[macro_use]
extern crate objc;

mod app;
mod font;
mod constants;
mod draw;
mod gfx;
mod input;
mod ipc;
mod state;

fn main() {
    font::install_embedded_satoshi();
    let (sender, receiver) = std::sync::mpsc::channel();
    ipc::start_stdin_reader(sender);
    app::run(receiver);
}
