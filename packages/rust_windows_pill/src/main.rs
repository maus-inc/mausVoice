#![windows_subsystem = "windows"]

mod constants;
mod font;
mod draw;
mod gfx;
mod input;
mod ipc;
mod pill;
mod state;

fn main() {
    font::install_embedded_satoshi();
    let (sender, receiver) = std::sync::mpsc::channel();
    ipc::start_stdin_reader(sender);
    pill::run(receiver);
}
