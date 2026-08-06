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

// Delegate a `reg query` process on Windows. Using the CLI (rather than the
// `windows`-crate registry FFI) keeps this module dependency-light and easy to
// reason about; `reg` ships on every supported Windows version.
#[cfg(target_os = "windows")]
fn read_machine_guid() -> Option<String> {
    use std::process::Command;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Output line looks like: "    MachineGuid    REG_SZ    {0E12...}"
    for part in text.split_whitespace() {
        if part.len() >= 2 && part.as_bytes()[0] == b'{' && part.ends_with('}') {
            return Some(part.to_string());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn read_platform_uuid() -> Option<String> {
    use std::process::Command;
    let out = Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(quote) = line.split('"').nth(3) {
                let trimmed = quote.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_machine_id_file() -> Option<String> {
    let raw = std::fs::read_to_string("/etc/machine-id").ok()?;
    let trimmed = raw.trim().to_string();
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