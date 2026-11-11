use std::sync::Arc;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSetupResult {
    Success,
    RequireRestart,
    /// The user dismissed the privilege-elevation prompt (e.g. the polkit
    /// authentication dialog on Linux). Distinct from `Failed` so the UI can
    /// stay quiet instead of reporting an error.
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSetupStatus {
    Ready,
    NeedsSetup,
    NeedsRestart,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PasteKeybindSupport {
    Disabled,
    PerApp,
    Global,
}

pub mod common;

// Deliberately not `cfg`-gated. The decision the Windows resume watcher makes
// from a `PBT_POWERSETTINGCHANGE` payload is pure data, and no CI job runs
// `cargo test` on Windows, so it lives where it is tested on every platform.
pub mod power_broadcast;

pub mod audio_stage;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub use linux::accessibility;
#[cfg(target_os = "linux")]
pub use linux::input;
#[cfg(target_os = "linux")]
pub use linux::monitor;
#[cfg(target_os = "linux")]
pub use linux::permissions;
#[cfg(target_os = "linux")]
pub use linux::position;
#[cfg(target_os = "linux")]
pub use linux::window;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::accessibility;
#[cfg(target_os = "macos")]
pub use macos::input;
#[cfg(target_os = "macos")]
pub use macos::monitor;
#[cfg(target_os = "macos")]
pub use macos::permissions;
#[cfg(target_os = "macos")]
pub use macos::position;
#[cfg(target_os = "macos")]
pub use macos::window;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows::accessibility;
#[cfg(target_os = "windows")]
pub use windows::input;
#[cfg(target_os = "windows")]
pub use windows::monitor;
#[cfg(target_os = "windows")]
pub use windows::permissions;
#[cfg(target_os = "windows")]
pub use windows::position;
#[cfg(target_os = "windows")]
pub use windows::window;

#[cfg(target_os = "linux")]
pub use linux::compositor;
#[cfg(target_os = "linux")]
pub use linux::init;
#[cfg(target_os = "linux")]
pub use linux::keyboard_language;
#[cfg(target_os = "macos")]
pub use macos::compositor;
#[cfg(target_os = "macos")]
pub use macos::init;
#[cfg(target_os = "macos")]
pub use macos::keyboard_language;
#[cfg(target_os = "windows")]
pub use windows::compositor;
#[cfg(target_os = "windows")]
pub use windows::init;
#[cfg(target_os = "windows")]
pub use windows::keyboard_language;

#[cfg(target_os = "linux")]
pub use linux::get_hotkey_strategy;
#[cfg(target_os = "macos")]
pub use macos::get_hotkey_strategy;
#[cfg(target_os = "windows")]
pub use windows::get_hotkey_strategy;

#[cfg(target_os = "linux")]
pub use linux::supports_app_detection;
#[cfg(target_os = "macos")]
pub use macos::supports_app_detection;
#[cfg(target_os = "windows")]
pub use windows::supports_app_detection;

#[cfg(target_os = "linux")]
pub use linux::supports_paste_keybinds;
#[cfg(target_os = "macos")]
pub use macos::supports_paste_keybinds;
#[cfg(target_os = "windows")]
pub use windows::supports_paste_keybinds;

#[cfg(target_os = "linux")]
pub use linux::overlay;
#[cfg(target_os = "macos")]
pub use macos::overlay;
#[cfg(target_os = "windows")]
pub use windows::overlay;

#[cfg(target_os = "linux")]
pub use linux::volume;
#[cfg(target_os = "macos")]
pub use macos::volume;
#[cfg(target_os = "windows")]
pub use windows::volume;

pub fn find_pid_by_window_title(title_substring: &str) -> Option<i32> {
    #[cfg(target_os = "windows")]
    {
        windows::window::find_pid_by_window_title(title_substring)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = title_substring;
        None
    }
}

pub mod app_info;

pub mod audio;

/// Why a device could not be opened, kept separate from "it is missing".
pub mod mic_usage;

/// What an error from a running capture stream means.
pub mod stream_fault;

pub mod paste_keybind;

#[cfg(desktop)]
pub mod keyboard;

pub enum SavedClipboard {
    Text(String),
    Image(arboard::ImageData<'static>),
    Empty,
}

impl SavedClipboard {
    pub fn save(clipboard: &mut arboard::Clipboard) -> Self {
        if let Ok(text) = clipboard.get_text() {
            return Self::Text(text);
        }
        if let Ok(image) = clipboard.get_image() {
            return Self::Image(image);
        }
        Self::Empty
    }

    pub fn restore(self) {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            match self {
                Self::Text(text) => {
                    let _ = cb.set_text(text);
                }
                Self::Image(image) => {
                    let _ = cb.set_image(image);
                }
                Self::Empty => {}
            }
        }
    }
}

pub type LevelCallback = Arc<dyn Fn(Vec<f32>) + Send + Sync>;
/// Receives a batch of samples plus the absolute index of the batch's first
/// sample in the recording, so consumers can place audio on an absolute
/// timeline instead of assuming every batch is contiguous.
pub type ChunkCallback = Arc<dyn Fn(Vec<f32>, u64) + Send + Sync>;

/// The pre-warm surface: holding a capture device open between dictations.
///
/// Separate from [`Recorder`] rather than folded into it, because recording and
/// holding are different lifetimes. A recorder is asked to capture and then to
/// stop; this asks for a device to be opened and left open. Folding them would
/// put "open without recording" on every recorder implementation, including any
/// that cannot express it, and every recorder would have to answer for a policy
/// it does not implement.
pub trait WarmCapture: Send + Sync {
    /// Opens a capture device and holds it, without recording.
    ///
    /// `preroll` is how much audio from before a press to keep.
    fn warm_open(&self, preroll: std::time::Duration) -> Result<(), String>;

    /// Changes how much pre-press audio is kept, resizing a held ring rather
    /// than reopening the device.
    fn set_preroll(&self, preroll: std::time::Duration);

    /// Resolves the device a press would use, without opening it.
    fn prepare(&self) -> Result<String, String>;

    /// Reopens the held stream if a better device appeared.
    ///
    /// A stream is bound to the device it was built on, so it cannot follow a
    /// headset being plugged in; the only way to use the new device is to close
    /// and reopen.
    fn refresh_device(&self) {}

    /// Keeps the stream that is already open until it is closed.
    ///
    /// Separate from `set_linger` because a linger of zero closes a stream. A
    /// caller that has just opened one, or has just been handed one by a stop,
    /// needs to keep it without passing through the value that would close it.
    fn promote_to_hold(&self) {}

    /// Closes the held stream and stops holding it, leaving the post-recording
    /// window alone.
    ///
    /// Distinct from setting the window to zero: this is the app releasing the
    /// device for its own reasons, and the window is a preference the user chose.
    /// Conflating them turned the window off whenever anything released the
    /// microphone.
    fn release_hold(&self);

    /// Closes the held stream.
    fn warm_close(&self);

    /// Whether a stream is held right now *and usable*, which is what "ready"
    /// means to the user and what the dialog reports.
    ///
    /// Deliberately not the same question as [`Self::has_held_stream`]: a stream
    /// that opened and delivered nothing is held but not ready. Use this one for
    /// anything the user reads, and `has_held_stream` for anything that has to
    /// release the device.
    fn is_ready(&self) -> bool;

    /// Whether a stream is held right now, usable or not.
    ///
    /// This is the structural question, and the exit path is why it exists: a
    /// held stream keeps the OS microphone indicator lit whether or not it can
    /// serve a press, so releasing it at exit must not ask `is_ready`, which
    /// answers `false` for exactly the broken stream that most needs closing.
    fn has_held_stream(&self) -> bool {
        self.is_ready()
    }

    /// Sets the hold policy, in milliseconds: 0 closes at stop, a finite value
    /// is a window, and `u64::MAX` holds until closed.
    fn set_linger(&self, linger_ms: u64);

    /// One readable line of policy and last-start state.
    fn status_line(&self) -> String;

    /// The stage timing of the most recent capture start, oldest first.
    fn last_startup(&self) -> Option<Vec<(String, u64)>> {
        None
    }
}

pub trait Recorder: Send + Sync {
    fn start(
        &self,
        level_callback: Option<LevelCallback>,
        chunk_callback: Option<ChunkCallback>,
    ) -> Result<(), Box<dyn std::error::Error>>;
    fn stop(&self) -> Result<crate::domain::RecordingResult, Box<dyn std::error::Error>>;
    fn pause(&self) -> Result<(), Box<dyn std::error::Error>>;
    fn resume(&self) -> Result<(), Box<dyn std::error::Error>>;
    fn set_preferred_input_device(&self, _name: Option<String>) {}
    fn clear_device_cache(&self) {}
    fn current_sample_rate(&self) -> Option<u32> {
        None
    }
}
