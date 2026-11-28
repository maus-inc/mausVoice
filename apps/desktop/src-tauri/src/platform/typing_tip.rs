/// Target-safety classification for the sustained-typing voice tip.
///
/// Kept free of any field-value, selection, or clipboard reads: only structural
/// roles, secure-input flags, process/bundle identifiers, and window-level
/// private-browsing markers are inspected, and only the coarse eligibility
/// verdict crosses IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TypingTipTargetEligibility {
    Eligible,
    SecureInput,
    PrivateContext,
    NotEditable,
    Unknown,
}

const SENSITIVE_APP_MARKERS: &[&str] = &[
    "1password",
    "agilebits",
    "bitwarden",
    "keepass",
    "dashlane",
    "lastpass",
    "proton pass",
    "protonpass",
    "me.proton.pass",
    "enpass",
    "nordpass",
    "roboform",
    "keeper",
    "keychain access",
    "keychainaccess",
    "securityagent",
    "coreservicesuiagent",
    "credentialuibroker",
    "consent.exe",
    "polkit",
    "pinentry",
    "gcr-prompter",
    "ssh-askpass",
    // Dedicated terminal emulators: shell sessions routinely receive typed
    // secrets (ssh, sudo, password prompts) and dictation output is unsafe
    // there, so sustained typing in them never earns the voice tip.
    "terminal",
    "iterm",
    "warp",
    "alacritty",
    "kitty",
    "wezterm",
    "konsole",
    "xterm",
    "tilix",
    "windowsterminal",
    "wt.exe",
    "cmd.exe",
    "powershell",
    "conemu",
    "cmder",
];

// Localized browser private/incognito window markers across Chromium, Firefox,
// Safari, Edge, Brave, Arc, Opera, Vivaldi, and Tor Browser.
const PRIVATE_WINDOW_MARKERS: &[&str] = &[
    "incognito",
    "inprivate",
    "private browsing",
    "private window",
    "tor browser",
    "navigation privée",
    "fenêtre privée",
    "privates fenster",
    "inkognito",
    "privater modus",
    "modo incógnito",
    "ventana privada",
    "navegación privada",
    "navigazione in incognito",
    "finestra privata",
    "navegação privada",
    "janela privada",
    "janela anônima",
    "시크릿",
    "사생활 보호",
    "無痕",
    "隱私瀏覽",
    "隐私浏览",
];

pub fn is_sensitive_app_identifier(value: &str) -> bool {
    let lower = value.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }
    SENSITIVE_APP_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

pub fn is_private_browsing_title(value: &str) -> bool {
    let lower = value.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }
    PRIVATE_WINDOW_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

pub fn classify_context_metadata(
    app_identifiers: &[Option<&str>],
    window_title: Option<&str>,
) -> Option<TypingTipTargetEligibility> {
    if app_identifiers
        .iter()
        .flatten()
        .any(|id| is_sensitive_app_identifier(id))
    {
        return Some(TypingTipTargetEligibility::SecureInput);
    }

    if app_identifiers
        .iter()
        .flatten()
        .any(|id| id.to_lowercase().contains("tor browser") || id.eq_ignore_ascii_case("tor"))
    {
        return Some(TypingTipTargetEligibility::PrivateContext);
    }

    if let Some(title) = window_title {
        if is_private_browsing_title(title) {
            return Some(TypingTipTargetEligibility::PrivateContext);
        }
    }

    None
}

#[derive(Debug, Clone, Default)]
pub struct MacosFocusMetadata {
    pub secure_event_input_enabled: bool,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub ax_role: Option<String>,
    pub ax_subrole: Option<String>,
    pub is_inside_web_area: bool,
    pub selected_text_settable: bool,
    pub value_settable: bool,
}

pub fn classify_macos_focus(meta: &MacosFocusMetadata) -> TypingTipTargetEligibility {
    if meta.secure_event_input_enabled {
        return TypingTipTargetEligibility::SecureInput;
    }

    if matches!(meta.ax_role.as_deref(), Some("AXSecureTextField"))
        || matches!(meta.ax_subrole.as_deref(), Some("AXSecureTextField"))
    {
        return TypingTipTargetEligibility::SecureInput;
    }

    if let Some(verdict) = classify_context_metadata(
        &[meta.bundle_id.as_deref(), meta.app_name.as_deref()],
        meta.window_title.as_deref(),
    ) {
        return verdict;
    }

    let Some(role) = meta.ax_role.as_deref() else {
        return TypingTipTargetEligibility::Unknown;
    };

    const EDITABLE_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];
    if EDITABLE_ROLES.contains(&role) {
        return TypingTipTargetEligibility::Eligible;
    }

    if meta.selected_text_settable || meta.value_settable {
        return TypingTipTargetEligibility::Eligible;
    }

    // Web areas with an unverified non-text role stay unknown rather than
    // guessing whether a custom rich editor or a password input has focus.
    if meta.is_inside_web_area {
        return TypingTipTargetEligibility::Unknown;
    }

    TypingTipTargetEligibility::NotEditable
}

#[derive(Debug, Clone, Default)]
pub struct WindowsFocusMetadata {
    pub window_class: Option<String>,
    pub window_title: Option<String>,
    pub exe_name: Option<String>,
    pub exe_path: Option<String>,
    pub is_password: Option<bool>,
    pub is_non_text_control: Option<bool>,
}

pub fn classify_windows_focus(meta: &WindowsFocusMetadata) -> TypingTipTargetEligibility {
    if matches!(meta.window_class.as_deref(), Some("Progman" | "WorkerW")) {
        return TypingTipTargetEligibility::NotEditable;
    }

    if let Some(verdict) = classify_context_metadata(
        &[meta.exe_name.as_deref(), meta.exe_path.as_deref()],
        meta.window_title.as_deref(),
    ) {
        return verdict;
    }

    match meta.is_password {
        Some(true) => return TypingTipTargetEligibility::SecureInput,
        None => return TypingTipTargetEligibility::Unknown,
        Some(false) => {}
    }

    match meta.is_non_text_control {
        Some(true) => TypingTipTargetEligibility::NotEditable,
        None => TypingTipTargetEligibility::Unknown,
        Some(false) => TypingTipTargetEligibility::Eligible,
    }
}

pub fn check_typing_tip_target_eligibility() -> TypingTipTargetEligibility {
    #[cfg(target_os = "macos")]
    {
        super::macos::accessibility::check_typing_tip_target_eligibility()
    }
    #[cfg(target_os = "windows")]
    {
        super::windows::accessibility::check_typing_tip_target_eligibility()
    }
    #[cfg(target_os = "linux")]
    {
        check_linux_typing_tip_target_eligibility()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        TypingTipTargetEligibility::Unknown
    }
}

#[cfg(target_os = "linux")]
fn check_linux_typing_tip_target_eligibility() -> TypingTipTargetEligibility {
    use ferrous_focus::{FocusTracker, FocusTrackerConfig};
    use std::sync::atomic::{AtomicBool, Ordering};

    if super::linux::detect::is_wayland() {
        return TypingTipTargetEligibility::Unknown;
    }

    let tracker = FocusTracker::with_config(FocusTrackerConfig::new());
    let stop = AtomicBool::new(false);
    let mut captured = None;
    let res = tracker.track_focus_with_stop(
        |win| {
            captured = Some(win);
            stop.store(true, Ordering::Relaxed);
            Ok(())
        },
        &stop,
    );

    if res.is_ok() {
        if let Some(win) = captured {
            if let Some(verdict) = classify_context_metadata(
                &[win.process_name.as_deref()],
                win.window_title.as_deref(),
            ) {
                return verdict;
            }
        }
    }

    // X11 window metadata cannot distinguish password inputs from plain fields
    // without reading AT-SPI trees; fail closed for external Linux windows.
    TypingTipTargetEligibility::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_password_managers_and_system_credential_prompts() {
        for sample in [
            "com.1password.1password",
            "1Password.exe",
            "com.bitwarden.desktop",
            "org.keepassxc.keepassxc",
            "com.apple.keychainaccess",
            "SecurityAgent",
            "CredentialUIBroker.exe",
            "gcr-prompter",
        ] {
            assert!(
                is_sensitive_app_identifier(sample),
                "expected {sample} to classify as sensitive"
            );
        }
        assert!(!is_sensitive_app_identifier("com.apple.Notes"));
        assert!(!is_sensitive_app_identifier("Code.exe"));
    }

    #[test]
    fn detects_terminal_emulators_as_sensitive() {
        for sample in [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "dev.warp.Warp-Stable",
            "Alacritty.exe",
            "kitty",
            "org.wezfurlong.wezterm",
            "org.kde.konsole",
            "xfce4-terminal",
            "xterm",
            "WindowsTerminal.exe",
            "wt.exe",
            "cmd.exe",
            "powershell.exe",
        ] {
            assert!(
                is_sensitive_app_identifier(sample),
                "expected {sample} to classify as sensitive"
            );
        }
    }

    #[test]
    fn detects_private_browsing_titles_across_locales() {
        for sample in [
            "New Tab - Google Chrome (Incognito)",
            "Search — Mozilla Firefox (Private Browsing)",
            "Start — Microsoft Edge [InPrivate]",
            "Private Window",
            "DuckDuckGo — Tor Browser",
            "Nouvel onglet - Navigation privée",
            "Neuer Tab – Inkognito",
            "Nueva pestaña - Modo incógnito",
            "새 탭 - Chrome(시크릿)",
            "新分頁 - 無痕視窗",
        ] {
            assert!(
                is_private_browsing_title(sample),
                "expected {sample} to classify as private browsing"
            );
        }
        assert!(!is_private_browsing_title("Project roadmap - Notion"));
        assert!(!is_private_browsing_title("Inbox - Mail"));
    }

    #[test]
    fn macos_classifier_blocks_secure_event_input_and_secure_subroles() {
        let base = MacosFocusMetadata {
            ax_role: Some("AXTextField".into()),
            app_name: Some("Safari".into()),
            window_title: Some("Sign in".into()),
            ..Default::default()
        };

        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                secure_event_input_enabled: true,
                ..base.clone()
            }),
            TypingTipTargetEligibility::SecureInput
        );

        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                ax_role: Some("AXSecureTextField".into()),
                ..base.clone()
            }),
            TypingTipTargetEligibility::SecureInput
        );

        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                ax_subrole: Some("AXSecureTextField".into()),
                ..base.clone()
            }),
            TypingTipTargetEligibility::SecureInput
        );
    }

    #[test]
    fn macos_classifier_blocks_private_windows_and_non_editable_controls() {
        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                ax_role: Some("AXTextArea".into()),
                app_name: Some("Google Chrome".into()),
                window_title: Some("Draft - Google Chrome (Incognito)".into()),
                ..Default::default()
            }),
            TypingTipTargetEligibility::PrivateContext
        );

        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                ax_role: Some("AXButton".into()),
                app_name: Some("Notes".into()),
                ..Default::default()
            }),
            TypingTipTargetEligibility::NotEditable
        );

        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                ax_role: Some("AXGroup".into()),
                is_inside_web_area: true,
                ..Default::default()
            }),
            TypingTipTargetEligibility::Unknown
        );

        assert_eq!(
            classify_macos_focus(&MacosFocusMetadata {
                ax_role: Some("AXTextArea".into()),
                app_name: Some("Notes".into()),
                window_title: Some("Weekly update".into()),
                ..Default::default()
            }),
            TypingTipTargetEligibility::Eligible
        );
    }

    #[test]
    fn windows_classifier_blocks_passwords_private_windows_and_unknown_uia() {
        assert_eq!(
            classify_windows_focus(&WindowsFocusMetadata {
                window_class: Some("Progman".into()),
                ..Default::default()
            }),
            TypingTipTargetEligibility::NotEditable
        );

        assert_eq!(
            classify_windows_focus(&WindowsFocusMetadata {
                exe_name: Some("msedge.exe".into()),
                window_title: Some("New tab - InPrivate - Microsoft Edge".into()),
                is_password: Some(false),
                is_non_text_control: Some(false),
                ..Default::default()
            }),
            TypingTipTargetEligibility::PrivateContext
        );

        assert_eq!(
            classify_windows_focus(&WindowsFocusMetadata {
                exe_name: Some("chrome.exe".into()),
                window_title: Some("Login".into()),
                is_password: Some(true),
                is_non_text_control: Some(false),
                ..Default::default()
            }),
            TypingTipTargetEligibility::SecureInput
        );

        assert_eq!(
            classify_windows_focus(&WindowsFocusMetadata {
                exe_name: Some("notepad.exe".into()),
                window_title: Some("notes.txt".into()),
                is_password: None,
                is_non_text_control: Some(false),
                ..Default::default()
            }),
            TypingTipTargetEligibility::Unknown
        );

        assert_eq!(
            classify_windows_focus(&WindowsFocusMetadata {
                exe_name: Some("notepad.exe".into()),
                window_title: Some("notes.txt".into()),
                is_password: Some(false),
                is_non_text_control: Some(false),
                ..Default::default()
            }),
            TypingTipTargetEligibility::Eligible
        );
    }
}
