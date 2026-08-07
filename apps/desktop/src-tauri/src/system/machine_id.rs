use std::sync::OnceLock;

// A stable, per-machine identifier used to strengthen the built-in fallback
// secret for API-key-at-rest encryption. Replacing a static value + user path
// with a genuine OS device id means an attacker who copies a database to
// another machine cannot decrypt the keys, because this salt does not travel
// with the data.
static MACHINE_ID: OnceLock<Option<String>> = OnceLock::new();

/// Returns the OS stable device identifier, if the platform exposes one.
/// - Windows: `MachineGuid` under `SOFTWARE\Microsoft\Cryptography`
/// - Linux: the D-Bus `machine-id` in `/etc/machine-id`
/// - macOS: the IOPlatformUUID reported by `ioreg`
pub(crate) fn machine_id() -> Option<&'static str> {
    MACHINE_ID.get_or_init(resolve_machine_id).as_deref()
}

// Spawn a command, require a clean exit, and return its stdout. The Windows
// registry read and the macOS platform-UUID read share this shape; keeping it
// here avoids duplicating the spawn/status/output dance. Only built on the
// platforms that consume it so cargo clippy -- -D warnings doesn't flag it as
// dead code on Linux.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run_and_read_stdout(program: &str, args: &[&str]) -> Option<String> {
    use std::process::Command;
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

// Delegate a `reg query` process on Windows. Using the CLI (rather than the
// `windows`-crate registry FFI) keeps this module dependency-light and easy to
// reason about; `reg` ships on every supported Windows version.
#[cfg(target_os = "windows")]
fn read_machine_guid() -> Option<String> {
    let text = run_and_read_stdout(
        "reg",
        &[
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ],
    )?;
    // Output line looks like: "    MachineGuid    REG_SZ    {0E12...}"
    text.split_whitespace().find(|part| {
        part.len() >= 2 && part.as_bytes()[0] == b'{' && part.ends_with('}')
    })
    .map(str::to_string)
}

#[cfg(target_os = "macos")]
fn read_platform_uuid() -> Option<String> {
    let text = run_and_read_stdout(
        "/usr/sbin/ioreg",
        &["-rd1", "-c", "IOPlatformExpertDevice"],
    )?;
    text.lines()
        .find(|line| line.contains("IOPlatformUUID"))
        .and_then(|line| line.split('"').nth(3))
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
}

#[cfg(target_os = "linux")]
fn read_machine_id_file() -> Option<String> {
    let trimmed = std::fs::read_to_string("/etc/machine-id").ok()?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn resolve_machine_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return read_machine_guid();
    }
    #[cfg(target_os = "macos")]
    {
        return read_platform_uuid();
    }
    #[cfg(target_os = "linux")]
    {
        return read_machine_id_file();
    }
    #[allow(unreachable_code)]
    None
}