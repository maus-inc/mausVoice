#[cfg(target_os = "macos")]
const TRAY_ICON_DEFAULT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/menu-item-macos-36.png"
));
#[cfg(target_os = "windows")]
const TRAY_ICON_DEFAULT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/menu-item-windows-36.png"
));
#[cfg(target_os = "linux")]
const TRAY_ICON_DEFAULT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/menu-item-linux-36.png"
));

#[cfg(target_os = "macos")]
const TRAY_ICON_UPDATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/update-macos-36.png"
));
#[cfg(target_os = "windows")]
const TRAY_ICON_UPDATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/update-windows-36.png"
));
#[cfg(target_os = "linux")]
const TRAY_ICON_UPDATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/update-linux-36.png"
));

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuIconVariant {
    Default,
    Update,
}

use crate::domain::EVT_REGISTER_CURRENT_APP;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{MenuItem, Submenu};

pub const EVT_INSTALL_UPDATE: &str = "tray-install-update";
pub const EVT_COPY_LAST_TRANSCRIPT: &str = "tray-copy-last-transcript";
pub const EVT_SET_DICTATION_LANGUAGE: &str = "tray-set-dictation-language";
pub const EVT_TOGGLE_PILL_VISIBILITY: &str = "tray-toggle-pill-visibility";
pub const EVT_RESET_PILL_POSITION: &str = "tray-reset-pill-position";

const TRAY_LANGUAGE_ITEM_PREFIX: &str = "tray-lang:";
const DASHBOARD_MENU_ID: &str = "open-dashboard";
const PILL_VISIBILITY_MENU_ID: &str = "toggle-pill-visibility";
const RESET_PILL_POSITION_MENU_ID: &str = "reset-pill-position";

const DASHBOARD_MENU_LABEL_OPEN: &str = "Open Dashboard";
const DASHBOARD_MENU_LABEL_HIDE: &str = "Hide Dashboard";

/// Label shown when clicking will hide the pill (effective `persistent` or
/// `while_active`). Also the pre-hydration default, so the first click always
/// has a defined meaning.
const PILL_MENU_LABEL_HIDE: &str = "Hide Pill";

#[derive(Clone)]
struct DashboardMenuLabels {
    open: String,
    hide: String,
}

impl Default for DashboardMenuLabels {
    fn default() -> Self {
        Self {
            open: DASHBOARD_MENU_LABEL_OPEN.to_string(),
            hide: DASHBOARD_MENU_LABEL_HIDE.to_string(),
        }
    }
}

static UPDATE_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
static REGISTER_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
static LANGUAGE_SUBMENU: OnceLock<Submenu<tauri::Wry>> = OnceLock::new();
static DASHBOARD_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
static DASHBOARD_MENU_LABELS: OnceLock<Mutex<DashboardMenuLabels>> = OnceLock::new();
static PILL_VISIBILITY_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
static RESET_PILL_POSITION_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrayLanguageMenuItem {
    pub code: String,
    pub label: String,
    pub checked: bool,
}

fn is_dashboard_visible(window: &tauri::WebviewWindow) -> Result<bool, String> {
    let visible = window.is_visible().map_err(|err| err.to_string())?;
    let minimized = window.is_minimized().map_err(|err| err.to_string())?;
    Ok(visible && !minimized)
}

fn set_dashboard_menu_visibility(visible: bool) -> Result<(), String> {
    let item = DASHBOARD_MENU_ITEM
        .get()
        .ok_or("Dashboard menu item not initialized")?;
    let labels = DASHBOARD_MENU_LABELS
        .get_or_init(|| Mutex::new(DashboardMenuLabels::default()))
        .lock()
        .map_err(|_| "Dashboard menu labels lock poisoned")?
        .clone();

    item.set_text(if visible { labels.hide } else { labels.open })
        .map_err(|err| err.to_string())
}

fn sync_dashboard_menu_state(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    set_dashboard_menu_visibility(is_dashboard_visible(&window)?)
}

fn hide_dashboard(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())?;

    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        crate::platform::window::keep_webview_active(window.app_handle(), "main");
        crate::platform::window::set_webview_keepalive(true);
    }
    #[cfg(target_os = "macos")]
    {
        crate::platform::macos::dock::hide_dock_icon().map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[cfg(desktop)]
pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::image::Image;
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    use tauri::tray::TrayIconBuilder;
    use tauri::{Emitter, Manager};

    let dashboard_visible = app
        .get_webview_window("main")
        .and_then(|window| is_dashboard_visible(&window).ok())
        .unwrap_or(false);
    let dashboard_item = MenuItem::with_id(
        app,
        DASHBOARD_MENU_ID,
        if dashboard_visible {
            DASHBOARD_MENU_LABEL_HIDE
        } else {
            DASHBOARD_MENU_LABEL_OPEN
        },
        true,
        None::<&str>,
    )?;
    let _ = DASHBOARD_MENU_ITEM.set(dashboard_item.clone());

    if let Some(main_window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        main_window.on_window_event(move |event| {
            let result = match event {
                // The app-level close handler always turns a main-window close
                // request into hide-to-tray. Update immediately, before a
                // platform can suspend the hidden webview.
                tauri::WindowEvent::CloseRequested { .. } => {
                    set_dashboard_menu_visibility(false)
                }
                tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_) => {
                    sync_dashboard_menu_state(&app_handle)
                }
                _ => Ok(()),
            };
            if let Err(err) = result {
                log::error!("Failed to sync dashboard tray label from window event: {err}");
            }
        });
    }

    let copy_last_transcript_item = MenuItem::with_id(
        app,
        "copy-last-transcript",
        "Copy Latest Transcript",
        true,
        None::<&str>,
    )?;
    let update_item =
        MenuItem::with_id(app, "install-update", "Install Update", false, None::<&str>)?;
    let _ = UPDATE_MENU_ITEM.set(update_item.clone());
    let register_current_app_item = MenuItem::with_id(
        app,
        "register-current-app",
        "Register current app",
        true,
        None::<&str>,
    )?;
    let _ = REGISTER_MENU_ITEM.set(register_current_app_item.clone());
    // Starts as "Hide Pill". The frontend re-syncs the label as soon as
    // preferences hydrate; until then this is the safe default action.
    let pill_visibility_item = MenuItem::with_id(
        app,
        PILL_VISIBILITY_MENU_ID,
        PILL_MENU_LABEL_HIDE,
        true,
        None::<&str>,
    )?;
    let _ = PILL_VISIBILITY_MENU_ITEM.set(pill_visibility_item.clone());
    // Starts disabled: the pill spawns at its default centre position, so
    // there is nothing to reset until the user drags it somewhere else.
    let reset_pill_position_item = MenuItem::with_id(
        app,
        RESET_PILL_POSITION_MENU_ID,
        "Reset Pill Position",
        false,
        None::<&str>,
    )?;
    let _ = RESET_PILL_POSITION_MENU_ITEM.set(reset_pill_position_item.clone());
    let language_submenu = SubmenuBuilder::new(app, "Language").build()?;
    let _ = LANGUAGE_SUBMENU.set(language_submenu.clone());
    let quit_item = MenuItem::with_id(app, "quit-mausvoice", "Quit mausVoice", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&dashboard_item)
        .item(&pill_visibility_item)
        .item(&reset_pill_position_item)
        .item(&copy_last_transcript_item)
        .item(&register_current_app_item)
        .item(&language_submenu)
        .item(&update_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let tray_icon_image = Image::from_bytes(TRAY_ICON_DEFAULT)?;

    #[allow(unused_mut)]
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("mausVoice")
        .icon(tray_icon_image)
        .on_menu_event(|app, event| match event.id().as_ref() {
            DASHBOARD_MENU_ID => {
                if let Some(window) = app.get_webview_window("main") {
                    let result = is_dashboard_visible(&window).and_then(|visible| {
                        if visible {
                            hide_dashboard(&window)
                        } else {
                            crate::platform::window::surface_main_window(&window)
                        }
                    });
                    if let Err(err) = result {
                        log::error!("Failed to toggle dashboard visibility: {err}");
                    }
                    if let Err(err) = sync_dashboard_menu_state(app) {
                        log::error!("Failed to sync dashboard tray label: {err}");
                    }
                }
            }
            "copy-last-transcript" => {
                if let Err(err) = app.emit(EVT_COPY_LAST_TRANSCRIPT, ()) {
                    log::error!("Failed to emit copy-last-transcript event: {err}");
                }
            }
            "install-update" => {
                if let Err(err) = app.emit(EVT_INSTALL_UPDATE, ()) {
                    log::error!("Failed to emit install-update event: {err}");
                }
            }
            PILL_VISIBILITY_MENU_ID => {
                // Emit only. The frontend owns the preference, so the next
                // value is derived there from the persisted state rather than
                // from a toggle held in the tray layer.
                if let Err(err) = app.emit(EVT_TOGGLE_PILL_VISIBILITY, ()) {
                    log::error!("Failed to emit toggle-pill-visibility event: {err}");
                }
            }
            RESET_PILL_POSITION_MENU_ID => {
                if let Err(err) = app.emit(EVT_RESET_PILL_POSITION, ()) {
                    log::error!("Failed to emit reset-pill-position event: {err}");
                }
            }
            "register-current-app" => {
                if let Err(err) = app.emit(EVT_REGISTER_CURRENT_APP, ()) {
                    log::error!("Failed to emit register-current-app event: {err}");
                }
            }
            "quit-mausvoice" => app.exit(0),
            other if other.starts_with(TRAY_LANGUAGE_ITEM_PREFIX) => {
                let code = other[TRAY_LANGUAGE_ITEM_PREFIX.len()..].to_string();
                if let Err(err) = app.emit(EVT_SET_DICTATION_LANGUAGE, code) {
                    log::error!("Failed to emit set-dictation-language event: {err}");
                }
            }
            _ => {}
        });

    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon_as_template(true);
    }

    let _tray_icon = tray_builder.build(app)?;

    Ok(())
}

pub fn set_menu_icon(app: &tauri::AppHandle, variant: MenuIconVariant) -> Result<(), String> {
    use tauri::image::Image;
    use tauri::tray::TrayIconId;

    let is_update = matches!(variant, MenuIconVariant::Update);

    let bytes = match variant {
        MenuIconVariant::Default => TRAY_ICON_DEFAULT,
        MenuIconVariant::Update => TRAY_ICON_UPDATE,
    };

    let tray = app
        .tray_by_id(&TrayIconId::new("main"))
        .ok_or("Tray icon not found")?;

    let image = Image::from_bytes(bytes).map_err(|err| err.to_string())?;
    tray.set_icon(Some(image)).map_err(|err| err.to_string())?;

    if let Some(update_item) = UPDATE_MENU_ITEM.get() {
        let _ = update_item.set_enabled(is_update);
    }

    #[cfg(target_os = "macos")]
    {
        tray.set_icon_as_template(true)
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

pub fn set_register_app_label(_app: &tauri::AppHandle, app_name: Option<String>) -> Result<(), String> {
    let Some(item) = REGISTER_MENU_ITEM.get() else {
        return Err("Register menu item not initialized".to_string());
    };
    let label = match app_name {
        Some(name) if !name.trim().is_empty() => format!("Register current app [{name}]"),
        _ => "Register current app".to_string(),
    };
    item.set_text(label).map_err(|err| err.to_string())
}

pub fn set_dashboard_menu_labels(
    app: &tauri::AppHandle,
    open_label: String,
    hide_label: String,
) -> Result<(), String> {
    if open_label.trim().is_empty() || hide_label.trim().is_empty() {
        return Err("Dashboard menu labels cannot be empty".to_string());
    }

    let mut labels = DASHBOARD_MENU_LABELS
        .get_or_init(|| Mutex::new(DashboardMenuLabels::default()))
        .lock()
        .map_err(|_| "Dashboard menu labels lock poisoned")?;
    *labels = DashboardMenuLabels {
        open: open_label,
        hide: hide_label,
    };
    drop(labels);

    sync_dashboard_menu_state(app)
}

/// Update the pill-visibility item's label.
///
/// Native menu state only: this never writes user preferences. The item stays
/// enabled in every state, so a single click is always a recovery path.
/// The frontend resolves the localized label and passes it here.
pub fn set_pill_visibility_menu_state(
    _app: &tauri::AppHandle,
    label: &str,
) -> Result<(), String> {
    let Some(item) = PILL_VISIBILITY_MENU_ITEM.get() else {
        return Err("Pill visibility menu item not initialized".to_string());
    };
    item.set_text(label)
        .map_err(|err| err.to_string())?;
    item.set_enabled(true).map_err(|err| err.to_string())
}

/// Enable or disable the "Reset Pill Position" tray menu item.
///
/// The frontend tracks whether the pill has been dragged away from its
/// default centre position and calls this to keep the menu item's state
/// in sync — disabled when there is nothing to reset, enabled otherwise.
pub fn set_reset_pill_position_enabled(
    _app: &tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let Some(item) = RESET_PILL_POSITION_MENU_ITEM.get() else {
        return Err("Reset pill position menu item not initialized".to_string());
    };
    item.set_enabled(enabled).map_err(|err| err.to_string())
}

pub fn set_tray_language_menu(
    app: &tauri::AppHandle,
    items: Vec<TrayLanguageMenuItem>,
) -> Result<(), String> {
    use tauri::menu::CheckMenuItem;

    let submenu = LANGUAGE_SUBMENU
        .get()
        .ok_or("Language submenu not initialized")?;

    let existing_count = submenu.items().map_err(|err| err.to_string())?.len();
    for _ in 0..existing_count {
        submenu.remove_at(0).map_err(|err| err.to_string())?;
    }

    for item in &items {
        let id = format!("{TRAY_LANGUAGE_ITEM_PREFIX}{}", item.code);
        let check_item = CheckMenuItem::with_id(
            app,
            id.as_str(),
            item.label.as_str(),
            true,
            item.checked,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        submenu.append(&check_item).map_err(|err| err.to_string())?;
    }

    Ok(())
}
