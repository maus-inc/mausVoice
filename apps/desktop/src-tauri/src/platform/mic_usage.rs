//! Why a device could not be opened, and whether something else is holding it.
//!
//! A microphone that another application has taken fails the same way on every
//! platform as one that was unplugged: the stream is not built, or it is built
//! and never called. cpal 0.15 collapses the busy case into
//! `DeviceNotAvailable` — its `DeviceBusy` kind only arrives in 0.18 — so the
//! variant alone cannot tell a user which of the two happened, and the message
//! they get is "no input device" for both.
//!
//! The distinction matters because the two have different remedies. An
//! unplugged device needs it plugged back in; a device in use needs the other
//! application closed. This module keeps the second class separate so the UI can
//! say which one it is.
//!
//! Everything here is a pure function of strings, so it can be tested without a
//! microphone, and the caller decides what to do with the answer.

/// What stopped the device from being opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFailure {
    /// Nothing stopped it: this is the absence of a failure.
    None,
    /// Another process is holding the device.
    InUseByAnotherApplication,
    /// The operating system refused access to the microphone.
    PermissionDenied,
    /// The device is gone: unplugged, or its endpoint disappeared.
    Unavailable,
    /// Something else failed, and the text does not identify it.
    Unknown,
}

impl OpenFailure {
    /// A short machine-stable token, for logs and for the status line.
    pub fn as_str(self) -> &'static str {
        match self {
            OpenFailure::None => "none",
            OpenFailure::InUseByAnotherApplication => "in_use",
            OpenFailure::PermissionDenied => "permission",
            OpenFailure::Unavailable => "unavailable",
            OpenFailure::Unknown => "unknown",
        }
    }

    /// Whether the user's own action can clear this failure right now.
    ///
    /// Used to decide whether offering "try again" is honest: a device that is
    /// in use clears when the other application releases it, and a permission
    /// clears in system settings, but an unplugged device does not clear by
    /// pressing anything.
    pub fn is_user_actionable(self) -> bool {
        matches!(
            self,
            OpenFailure::InUseByAnotherApplication | OpenFailure::PermissionDenied
        )
    }
}

/// Windows error codes that mean something specific here.
///
/// `AUDCLNT_E_DEVICE_IN_USE` is the one that matters: WASAPI returns it when a
/// client asks for a mode the device is already committed to. On the shared-mode
/// path most applications use it is rare, because Windows mixes the streams, but
/// it is the only code that says "someone else has it" rather than "it is gone".
///
/// `0x8889000A`. This was `0x8889_0004`, which is `AUDCLNT_E_DEVICE_INVALIDATED`
/// -- a device that vanished -- one digit away and the opposite meaning. Every
/// user whose headset was unplugged was told to close an application that had
/// done nothing.
const HRESULT_DEVICE_IN_USE: u32 = 0x8889_000A;
/// Access denied. With the Windows 11 microphone privacy switch off, WASAPI
/// fails the stream build with this before anything else can happen.
const HRESULT_ACCESS_DENIED: u32 = 0x8007_0005;

/// Text that a platform backend or cpal uses for "busy".
///
/// Matched case-insensitively. Every entry was taken from a message this
/// repository can actually receive, or from the backend cpal uses on the
/// platform named beside it; the tests pin the behaviour so a wrong entry is a
/// failing test rather than a wrong message shown to a user.
const IN_USE_MARKERS: &[&str] = &[
    // Linux, ALSA, when the card is opened exclusively by another process.
    "device or resource busy",
    // Linux, ALSA, when every subdevice of the card is claimed.
    "no available subdevice",
    // Windows, WASAPI, exclusive mode, through cpal 0.15's BackendSpecific text.
    //
    // The HRESULT is AUDCLNT_E_DEVICE_IN_USE (0x8889000A), and it needs to be
    // exactly that. 0x88890004 sits one digit away and is
    // AUDCLNT_E_DEVICE_INVALIDATED -- a device that vanished, not one another
    // application is holding -- so matching it here told every user whose
    // headset was unplugged to go and close an application that had done
    // nothing wrong, and sent them looking for a busy microphone that did not
    // exist. The name below is matched as well, because cpal's BackendSpecific
    // text carries whichever form the backend chose.
    "0x8889000a",
    "audclnt_e_device_in_use",
    // macOS, CoreAudio: the device is in use by another process and cannot be
    // opened in the requested mode.
    "in use by another",
    "kAudioUnitErr_DeviceInUse",
    "device is in use",
];

const PERMISSION_MARKERS: &[&str] = &[
    // Windows, microphone privacy switch, and any other E_ACCESSDENIED path.
    "0x80070005",
    "access is denied",
    "access denied",
    "permission denied",
    "eperm",
    // macOS, TCC. The backend's own wording for a refused capture.
    "not authorized",
    "unauthorized",
    "permission",
    // Linux, when the user is not in the audio group.
    "operation not permitted",
];

const UNAVAILABLE_MARKERS: &[&str] = &[
    // cpal 0.15's own rendering of DeviceNotAvailable, for every one of its
    // error enums: "The requested device is no longer available. For example,
    // it has been unplugged." Both phrasings are listed because "no longer
    // available" does not contain "not available" — an early version of this
    // list asserted it did, and the test caught it.
    "no longer available",
    "not available",
    "no input device",
    "no such device",
    "not found",
    "unplugged",
    "disconnected",
    "invalidated",
];

/// Classifies a device-open failure from its message.
///
/// Ordering is deliberate and is the whole point of the function: permission is
/// checked before "in use", because the Windows access-denied text also contains
/// the word "device" and a naive substring search for "in use" would be fine but
/// a naive search for "denied" after "in use" would not be. In-use is checked
/// before unavailable, because ALSA reports a busy card as "Device or resource
/// busy" and a naive "device" match would read it as missing.
pub fn classify_open_failure(message: &str) -> OpenFailure {
    let haystack = message.to_ascii_lowercase();

    if PERMISSION_MARKERS
        .iter()
        .any(|marker| haystack.contains(&marker.to_ascii_lowercase()))
    {
        return OpenFailure::PermissionDenied;
    }

    if IN_USE_MARKERS
        .iter()
        .any(|marker| haystack.contains(&marker.to_ascii_lowercase()))
    {
        return OpenFailure::InUseByAnotherApplication;
    }

    if UNAVAILABLE_MARKERS
        .iter()
        .any(|marker| haystack.contains(&marker.to_ascii_lowercase()))
    {
        return OpenFailure::Unavailable;
    }

    OpenFailure::Unknown
}

/// Classifies an HRESULT, which is more reliable than its rendered text.
///
/// The text form of a `windows::core::Error` is locale-dependent and can render
/// the code in either hex or decimal, so the numeric check runs first whenever
/// the code is available.
pub fn classify_hresult(code: u32) -> OpenFailure {
    match code {
        HRESULT_DEVICE_IN_USE => OpenFailure::InUseByAnotherApplication,
        HRESULT_ACCESS_DENIED => OpenFailure::PermissionDenied,
        _ => OpenFailure::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alsa_busy_is_in_use_not_missing() {
        // The distinction this module exists for: a busy card and an absent card
        // both mention "device", and only one of them is the user's problem to
        // solve by closing another application.
        assert_eq!(
            classify_open_failure(
                "ALSA function 'snd_pcm_open' failed with 'Device or resource busy'"
            ),
            OpenFailure::InUseByAnotherApplication
        );
        assert_eq!(
            classify_open_failure("Device or resource busy (os error 16)"),
            OpenFailure::InUseByAnotherApplication
        );
    }

    #[test]
    fn alsa_subdevice_exhaustion_is_in_use() {
        assert_eq!(
            classify_open_failure("ALSA: no available subdevice for 'default'"),
            OpenFailure::InUseByAnotherApplication
        );
    }

    #[test]
    fn wasapi_in_use_code_is_recognised_in_text_and_number() {
        assert_eq!(
            classify_open_failure("A backend-specific error has occurred: 0x8889000a"),
            OpenFailure::InUseByAnotherApplication
        );
        assert_eq!(
            classify_hresult(0x8889_000A),
            OpenFailure::InUseByAnotherApplication
        );
    }

    #[test]
    fn a_device_that_vanished_is_not_reported_as_another_application_holding_it() {
        // 0x88890004 is AUDCLNT_E_DEVICE_INVALIDATED: the endpoint went away. It
        // was the value of `HRESULT_DEVICE_IN_USE` and was in the in-use marker
        // list, one digit from the real AUDCLNT_E_DEVICE_IN_USE (0x8889000A), so
        // an unplugged device told the user to close an application that was
        // never holding anything.
        assert_ne!(
            classify_hresult(0x8889_0004),
            OpenFailure::InUseByAnotherApplication
        );
        assert_ne!(
            classify_open_failure("A backend-specific error has occurred: 0x88890004"),
            OpenFailure::InUseByAnotherApplication
        );
        // The other direction, so the rule above cannot be satisfied by simply
        // classifying nothing as in-use.
        assert_eq!(
            classify_hresult(0x8889_000A),
            OpenFailure::InUseByAnotherApplication
        );
    }

    #[test]
    fn windows_privacy_switch_is_permission_not_missing() {
        // With the privacy switch off, WASAPI returns E_ACCESSDENIED and cpal
        // reports it through the same BackendSpecific variant it uses for a
        // missing device. Reporting "no input device" here sends the user to
        // check their hardware instead of a setting.
        assert_eq!(
            classify_open_failure("A backend-specific error has occurred: 0x80070005"),
            OpenFailure::PermissionDenied
        );
        assert_eq!(classify_hresult(0x8007_0005), OpenFailure::PermissionDenied);
        assert_eq!(
            classify_open_failure("Access is denied. (0x80070005)"),
            OpenFailure::PermissionDenied
        );
    }

    #[test]
    fn cpal_device_not_available_text_is_unavailable() {
        // Verbatim from cpal 0.15.3's Display impl, which is what this
        // repository actually receives: the message is wrapped into
        // RecordingError::StreamBuild and reaches the classifier as text. The
        // second string is cpal's PlayStreamError wording, which reaches the
        // classifier through RecordingError::StreamPlay.
        assert_eq!(
            classify_open_failure(
                "The requested device is no longer available. For example, it has been unplugged."
            ),
            OpenFailure::Unavailable
        );
        assert_eq!(
            classify_open_failure("the device associated with the stream is no longer available"),
            OpenFailure::Unavailable
        );
    }

    #[test]
    fn unplugged_device_is_unavailable() {
        assert_eq!(
            classify_open_failure("no input device"),
            OpenFailure::Unavailable
        );
        assert_eq!(
            classify_open_failure("ALSA: No such device"),
            OpenFailure::Unavailable
        );
    }

    #[test]
    fn permission_wins_over_in_use_when_both_appear() {
        // A message that carries both must not be read as a contention problem:
        // telling the user to close another application would be wrong and would
        // send them looking for one that is not there.
        assert_eq!(
            classify_open_failure("device in use and access denied"),
            OpenFailure::PermissionDenied
        );
    }

    #[test]
    fn in_use_wins_over_unavailable_when_both_appear() {
        assert_eq!(
            classify_open_failure("device not available: device or resource busy"),
            OpenFailure::InUseByAnotherApplication
        );
    }

    #[test]
    fn unrecognised_text_is_unknown_not_guessed() {
        // Guessing here is how a user ends up closing applications at random.
        assert_eq!(
            classify_open_failure("stream build: something unexpected"),
            OpenFailure::Unknown
        );
        assert_eq!(classify_open_failure(""), OpenFailure::Unknown);
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert_eq!(
            classify_open_failure("DEVICE OR RESOURCE BUSY"),
            OpenFailure::InUseByAnotherApplication
        );
        assert_eq!(
            classify_open_failure("Access Denied"),
            OpenFailure::PermissionDenied
        );
    }

    #[test]
    fn tokens_are_stable() {
        // These strings are logged and compared, so they must not drift silently.
        assert_eq!(OpenFailure::InUseByAnotherApplication.as_str(), "in_use");
        assert_eq!(OpenFailure::PermissionDenied.as_str(), "permission");
        assert_eq!(OpenFailure::Unavailable.as_str(), "unavailable");
        assert_eq!(OpenFailure::Unknown.as_str(), "unknown");
        assert_eq!(OpenFailure::None.as_str(), "none");
    }

    #[test]
    fn only_actionable_failures_are_actionable() {
        assert!(OpenFailure::InUseByAnotherApplication.is_user_actionable());
        assert!(OpenFailure::PermissionDenied.is_user_actionable());
        // Pressing "try again" cannot reconnect a cable.
        assert!(!OpenFailure::Unavailable.is_user_actionable());
        assert!(!OpenFailure::Unknown.is_user_actionable());
        assert!(!OpenFailure::None.is_user_actionable());
    }
}

/// Who is holding the microphone right now, as far as this machine can tell.
///
/// `Known` is a measured answer and includes "nobody", which is the common case
/// and must not be confused with "we could not find out": the second is what a
/// status line cannot present as reassurance. Every failure to read the platform
/// returns `Unavailable` with the reason, never a guess.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureUsage {
    /// Something other than this application is capturing from an input device.
    HeldByOther { holders: Vec<String> },
    /// Capturing is possible and nothing else is doing it.
    Idle,
    /// This platform has no probe here, or the probe failed. The string says
    /// which, because a failed probe and an unimplemented one need different
    /// follow-up.
    Unavailable(String),
}

impl CaptureUsage {
    /// A one-line, machine-stable rendering, for logs and status lines.
    pub fn status_line(&self) -> String {
        match self {
            CaptureUsage::HeldByOther { holders } if holders.is_empty() => {
                "held_by_other".to_string()
            }
            CaptureUsage::HeldByOther { holders } => {
                format!("held_by_other[{}]", holders.join(","))
            }
            CaptureUsage::Idle => "idle".to_string(),
            CaptureUsage::Unavailable(reason) => format!("unavailable:{reason}"),
        }
    }
}

/// Reads the current capture usage from the platform.
///
/// This is a query, not a subscription: it opens nothing and holds nothing, so
/// it is safe to call while the app has the device held.
pub fn current_usage() -> CaptureUsage {
    #[cfg(target_os = "linux")]
    {
        linux::current_usage()
    }
    #[cfg(not(target_os = "linux"))]
    {
        CaptureUsage::Unavailable("no probe on this platform".to_string())
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    /// The environment variable that redirects the probe at another executable.
    ///
    /// Named once. The production read and every test write below go through
    /// this constant, so a misspelt variable name cannot point the probe at
    /// nothing: the tests would otherwise set one variable while the app read
    /// another, and the whole path they exist to cover would be exercised with
    /// the override silently ignored.
    pub(super) const PACTL_OVERRIDE_ENV: &str = "MAUSVOICE_PACTL";

    use super::CaptureUsage;
    use std::process::Command;

    /// Asks PulseAudio or PipeWire who is recording, through `pactl`.
    ///
    /// `pactl list source-outputs` prints one block per active recording stream,
    /// each carrying an `application.name` (or `media.name` when the client did
    /// not set one) and a `Source:` line naming the source it is attached to.
    /// A source whose name ends in `.monitor` is an output being looped back,
    /// not a microphone, so those are skipped: counting them would report a
    /// held microphone whenever anything played audio.
    ///
    /// `pactl` is the PulseAudio client, and PipeWire's pulse server answers the
    /// same protocol, so one probe covers both. It is not always installed, and
    /// a machine using pure ALSA has no server to ask at all; both cases return
    /// `Unavailable` rather than `Idle`, because reporting "nothing is recording"
    /// when nothing was asked is a false reassurance.
    pub fn current_usage() -> CaptureUsage {
        // The probe can be pointed at a different binary so the whole path,
        // including the subprocess call, can be exercised on a machine with no
        // audio server. Without this the parser is the only part that can ever
        // be tested, and a wrong argument or a misread exit status would only
        // show up on a user's machine.
        let binary = std::env::var(PACTL_OVERRIDE_ENV).unwrap_or_else(|_| "pactl".to_string());
        let output = match Command::new(&binary)
            .arg("list")
            .arg("source-outputs")
            .output()
        {
            Ok(output) => output,
            Err(err) => {
                return CaptureUsage::Unavailable(format!("pactl not runnable: {err}"));
            }
        };
        if !output.status.success() {
            return CaptureUsage::Unavailable(format!(
                "pactl exited {}",
                output.status.code().unwrap_or(-1)
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        CaptureUsage::from_pactl_listing(&text)
    }

    impl CaptureUsage {
        /// Parses `pactl list source-outputs` output.
        ///
        /// Split out from the command so the parsing is testable without an
        /// audio server, which is the only way it can be tested here.
        pub fn from_pactl_listing(listing: &str) -> CaptureUsage {
            let mut holders: Vec<String> = Vec::new();
            let mut application: Option<String> = None;
            let mut media: Option<String> = None;
            let mut source: Option<String> = None;

            let mut flush = |application: &mut Option<String>,
                             media: &mut Option<String>,
                             source: &mut Option<String>| {
                // Nothing recorded since the last block: an empty listing, or
                // the final flush after the last block. Emitting a holder here
                // would invent one — the first version of this did, and
                // reported "unknown" recording on a machine with no streams.
                if application.is_none() && media.is_none() && source.is_none() {
                    return;
                }
                let is_monitor = source
                    .as_deref()
                    .map(|value| value.trim().ends_with(".monitor"))
                    .unwrap_or(false);
                if !is_monitor {
                    let name = application
                        .take()
                        .or_else(|| media.take())
                        .unwrap_or_else(|| "unknown".to_string());
                    holders.push(name);
                }
                *application = None;
                *media = None;
                *source = None;
            };

            for line in listing.lines() {
                // Tab-indented property lines are the ones that matter, so the
                // indentation is dropped before the key is read. Without this
                // the split lands on the tab and every property is missed,
                // which reports every stream as an unknown holder.
                let trimmed = line.trim_start_matches(|c: char| c.is_whitespace());
                if trimmed.starts_with("Source Output #") {
                    flush(&mut application, &mut media, &mut source);
                    continue;
                }
                // Two separators are in use in the same listing: `Source: 55`
                // uses a colon, and properties inside the block use ` = `.
                // Reading only one of them finds the source but none of the
                // names, which is how every stream ends up reported as
                // "unknown".
                let Some((key, value)) =
                    trimmed.split_once('=').or_else(|| trimmed.split_once(':'))
                else {
                    continue;
                };
                // `application.name = "Firefox"` keeps the quotes pactl writes.
                let value = value.trim().trim_matches('"');
                // `application.name = "Firefox"` leaves a space on the key.
                match key.trim() {
                    "application.name" => application = Some(value.to_string()),
                    "media.name" => media = Some(value.to_string()),
                    "Source" => source = Some(value.to_string()),
                    _ => {}
                }
            }
            flush(&mut application, &mut media, &mut source);

            // The app's own held stream shows up in this listing. Reporting it
            // as another application would make keep-ready accuse itself.
            let own = std::env::current_exe()
                .ok()
                .and_then(|path| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
                .unwrap_or_default();
            holders.retain(|name| {
                // pactl reports the binary name for an unsigned app and the
                // desktop entry's name otherwise, so both are checked.
                let lower = name.to_ascii_lowercase();
                !lower.contains("mausvoice")
                    && (own.is_empty() || !lower.contains(&own.to_ascii_lowercase()))
            });
            holders.sort();
            holders.dedup();

            if holders.is_empty() {
                CaptureUsage::Idle
            } else {
                CaptureUsage::HeldByOther { holders }
            }
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::CaptureUsage;

    /// Two applications are recording from a real microphone.
    const TWO_HOLDERS: &str = "\
Source Output #12
\tDriver: PipeWire
\tOwner Module: 4294967295
\tClient: 41
\tSource: 55
\tProperties:
\t\tapplication.name = \"Firefox\"
\t\tmedia.name = \"AudioCallbackDriver\"
\tState: RUNNING
\tMute: no

Source Output #19
\tSource: 55
\tProperties:
\t\tapplication.name = \"obs\"

";

    #[test]
    fn two_applications_are_both_reported() {
        match CaptureUsage::from_pactl_listing(TWO_HOLDERS) {
            CaptureUsage::HeldByOther { holders } => {
                assert_eq!(holders, vec!["Firefox".to_string(), "obs".to_string()]);
            }
            other => panic!("expected two holders, got {other:?}"),
        }
    }

    #[test]
    fn empty_listing_is_idle_not_unknown() {
        // The distinction the type exists for: "nobody is recording" is a
        // measured answer and must not be reported as "could not find out".
        assert_eq!(CaptureUsage::from_pactl_listing(""), CaptureUsage::Idle);
    }

    #[test]
    fn monitor_sources_do_not_count_as_a_held_microphone() {
        // A loopback of the speakers is a source-output too, but it is not a
        // microphone. Counting it would report the mic as busy whenever the
        // machine played any audio at all.
        let listing = "\
Source Output #31
\tSource: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
\tProperties:
\t\tapplication.name = \"Recording Tool\"

";
        assert_eq!(
            CaptureUsage::from_pactl_listing(listing),
            CaptureUsage::Idle
        );
    }

    #[test]
    fn our_own_hold_is_not_another_application() {
        // Keep-ready holds the device; if its own stream counted, the app would
        // accuse itself of holding the microphone and the warning would be
        // permanently on for the users who turned the feature on.
        let listing = "\
Source Output #44
\tSource: 55
\tProperties:
\t\tapplication.name = \"mausVoice\"

";
        assert_eq!(
            CaptureUsage::from_pactl_listing(listing),
            CaptureUsage::Idle
        );
    }

    #[test]
    fn a_stream_without_an_application_name_falls_back_to_media_name() {
        let listing = "\
Source Output #51
\tSource: 55
\tProperties:
\t\tmedia.name = \"ALSA plug-in [zoom]\"

";
        match CaptureUsage::from_pactl_listing(listing) {
            CaptureUsage::HeldByOther { holders } => {
                assert_eq!(holders, vec!["ALSA plug-in [zoom]".to_string()]);
            }
            other => panic!("expected one holder, got {other:?}"),
        }
    }

    #[test]
    fn duplicate_holders_are_collapsed() {
        let listing = "\
Source Output #60
\tSource: 55
\tProperties:
\t\tapplication.name = \"Firefox\"

Source Output #61
\tSource: 55
\tProperties:
\t\tapplication.name = \"Firefox\"

";
        match CaptureUsage::from_pactl_listing(listing) {
            CaptureUsage::HeldByOther { holders } => {
                assert_eq!(holders, vec!["Firefox".to_string()]);
            }
            other => panic!("expected a deduplicated holder, got {other:?}"),
        }
    }

    #[test]
    fn status_line_is_stable() {
        assert_eq!(CaptureUsage::Idle.status_line(), "idle");
        assert_eq!(
            CaptureUsage::HeldByOther {
                holders: vec!["Zoom".to_string()]
            }
            .status_line(),
            "held_by_other[Zoom]"
        );
        assert_eq!(
            CaptureUsage::Unavailable("pactl not runnable".to_string()).status_line(),
            "unavailable:pactl not runnable"
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_command_tests {
    use super::linux::current_usage;
    // The override variable's name, imported from the module that reads it so
    // the tests cannot set one variable while the app reads another.
    use super::linux::PACTL_OVERRIDE_ENV;
    use super::CaptureUsage;
    use std::io::Write;

    /// Serialises the tests that point the probe at a fake `pactl`.
    ///
    /// `MAUSVOICE_PACTL` is process-global and Rust runs test functions on
    /// parallel threads, so without this the tests race: one sets the variable,
    /// another removes it between the set and the probe, and the probe then runs
    /// the real `pactl` or nothing at all. Measured before this was added: **3 of
    /// 12** runs of this module failed, each in a different test.
    ///
    /// A mutex rather than `--test-threads=1`, because the serialisation travels
    /// with the tests: a flag on a command line is a flag the next person does
    /// not type.
    static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Holds the guard for as long as the returned value is alive.
    fn serialize_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Writes an executable shell script and points the probe at it.
    ///
    /// This exercises `current_usage` itself — the subprocess call, the exit
    /// status check and the parse — rather than only `from_pactl_listing`. The
    /// two failure modes it pins are the ones a parser test cannot see: a probe
    /// that cannot be run at all, and a probe that runs and fails.
    fn fake_pactl(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        let path = dir.join("pactl");
        let mut file = std::fs::File::create(&path).expect("create script");
        // The shebang and the trailing newline matter: without them the kernel
        // refuses to execute the file and the test would pass for the wrong
        // reason, reporting "not runnable" instead of the intended outcome.
        writeln!(file, "#!/bin/sh\n{body}").expect("write script");
        file.sync_all().expect("flush script");
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).expect("stat").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    fn a_listing_with_one_holder_is_read_through_the_subprocess() {
        let _guard = serialize_env();
        let dir = std::env::temp_dir().join(format!("mausvoice-pactl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let script = fake_pactl(
            &dir,
            "cat <<'EOF'\nSource Output #7\n\tSource: 55\n\tProperties:\n\t\tapplication.name = \"Zoom\"\nEOF",
        );
        std::env::set_var(PACTL_OVERRIDE_ENV, &script);
        let usage = current_usage();
        std::env::remove_var(PACTL_OVERRIDE_ENV);
        assert_eq!(
            usage,
            CaptureUsage::HeldByOther {
                holders: vec!["Zoom".to_string()]
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_probe_that_cannot_run_is_unavailable_not_idle() {
        let _guard = serialize_env();
        std::env::set_var(PACTL_OVERRIDE_ENV, "/nonexistent/pactl-binary");
        let usage = current_usage();
        std::env::remove_var(PACTL_OVERRIDE_ENV);
        match usage {
            CaptureUsage::Unavailable(reason) => {
                assert!(reason.contains("not runnable"), "reason was {reason}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn a_probe_that_fails_is_unavailable_not_idle() {
        let _guard = serialize_env();
        let dir = std::env::temp_dir().join(format!("mausvoice-pactl-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let script = fake_pactl(&dir, "exit 3");
        std::env::set_var(PACTL_OVERRIDE_ENV, &script);
        let usage = current_usage();
        std::env::remove_var(PACTL_OVERRIDE_ENV);
        match usage {
            CaptureUsage::Unavailable(reason) => {
                assert!(reason.contains("exited 3"), "reason was {reason}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
