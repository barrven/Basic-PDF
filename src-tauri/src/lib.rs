//! Tauri shell for Basic PDF: the counterpart of `electron/main.js`.
//!
//! The renderer (`index.html` + `src/*`) is shared with the Electron shell.
//! `bridge.js` maps `window.electronAPI` onto the commands defined here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{ContextMenu, MenuBuilder, MenuItemBuilder};
use tauri::{
    AppHandle, Emitter, Manager, State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const STORE_FILE: &str = "basic-pdf.json";
const MENU_ID_PREFIX: &str = "ctx:";

#[derive(Default)]
struct AppState {
    dirty: AtomicBool,
    pending_open_path: Mutex<Option<String>>,
    store: Mutex<Option<Map<String, Value>>>,
    /// Sender for the context menu currently on screen, if any.
    menu_choice: Mutex<Option<mpsc::Sender<String>>>,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- store ----

fn store_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join(STORE_FILE))
}

fn read_json_object(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// First run of the Tauri build: carry over the Electron app's settings
/// (signature library, theme, last folder) from `%APPDATA%/Basic PDF`.
fn import_electron_store(app: &AppHandle) -> Option<Map<String, Value>> {
    let legacy = app.path().config_dir().ok()?.join("Basic PDF").join(STORE_FILE);
    read_json_object(&legacy)
}

fn with_store<T>(
    app: &AppHandle,
    state: &AppState,
    f: impl FnOnce(&mut Map<String, Value>) -> (T, bool),
) -> CmdResult<T> {
    let mut guard = state.store.lock().map_err(err)?;
    if guard.is_none() {
        let path = store_path(app)?;
        let loaded = read_json_object(&path)
            .or_else(|| import_electron_store(app))
            .unwrap_or_default();
        *guard = Some(loaded);
    }
    let map = guard.as_mut().expect("store loaded above");
    let (out, changed) = f(map);
    if changed {
        let path = store_path(app)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let text = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(err)?;
        std::fs::write(&path, text).map_err(err)?;
    }
    Ok(out)
}

fn store_read(app: &AppHandle, state: &AppState, key: &str) -> Option<Value> {
    with_store(app, state, |m| (m.get(key).cloned(), false)).ok().flatten()
}

fn store_write(app: &AppHandle, state: &AppState, key: &str, value: Value) -> CmdResult<()> {
    with_store(app, state, |m| {
        m.insert(key.to_string(), value);
        ((), true)
    })
}

fn remember_last_dir(app: &AppHandle, state: &AppState, file_path: &str) {
    if let Some(dir) = Path::new(file_path).parent().and_then(|d| d.to_str()) {
        if !dir.is_empty() {
            let _ = store_write(app, state, "lastDir", Value::String(dir.to_string()));
        }
    }
}

/// The remembered folder, if it still exists.
fn last_dir(app: &AppHandle, state: &AppState) -> Option<PathBuf> {
    let dir = PathBuf::from(store_read(app, state, "lastDir")?.as_str()?);
    dir.is_dir().then_some(dir)
}

#[tauri::command(async)]
fn store_get(app: AppHandle, state: State<'_, AppState>, key: String) -> Option<Value> {
    store_read(&app, &state, &key)
}

#[tauri::command(async)]
fn store_set(app: AppHandle, state: State<'_, AppState>, key: String, value: Value) -> CmdResult<bool> {
    store_write(&app, &state, &key, value)?;
    Ok(true)
}

// ---------------------------------------------------------------- files ----

#[tauri::command(async)]
fn pick_open_file(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let mut dialog = app.dialog().file().set_parent(&window).add_filter("PDF", &["pdf"]);
    if let Some(dir) = last_dir(&app, &state) {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(err)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
fn pick_save_path(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    default_name: String,
) -> CmdResult<Option<String>> {
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF", &["pdf"])
        .set_file_name(default_name);
    if let Some(dir) = last_dir(&app, &state) {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(err)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Returns the raw bytes (an ArrayBuffer in the renderer), not a JSON array.
#[tauri::command(async)]
fn read_file_bytes(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<Response> {
    let bytes = std::fs::read(&path).map_err(err)?;
    remember_last_dir(&app, &state, &path);
    Ok(Response::new(bytes))
}

/// Body: the PDF bytes. Header `x-path`: percent-encoded destination path.
#[tauri::command(async)]
fn save_file(app: AppHandle, state: State<'_, AppState>, request: Request<'_>) -> CmdResult<bool> {
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(err)?
        .into_owned();
    if path.is_empty() {
        return Err("empty save path".into());
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file expects a raw byte body".into());
    };
    std::fs::write(&path, bytes).map_err(err)?;
    remember_last_dir(&app, &state, &path);
    Ok(true)
}

fn is_pdf_path(arg: &str) -> bool {
    !arg.starts_with('-') && arg.to_lowercase().ends_with(".pdf")
}

/// Windows "Open with" launches the exe with the PDF as an argv entry.
fn pdf_path_from_args() -> Option<String> {
    let cwd = std::env::current_dir().ok();
    std::env::args().skip(1).find(|a| is_pdf_path(a)).map(|arg| {
        let p = PathBuf::from(&arg);
        let abs = match (&cwd, p.is_absolute()) {
            (Some(cwd), false) => cwd.join(p),
            _ => p,
        };
        abs.to_string_lossy().into_owned()
    })
}

#[tauri::command]
fn take_pending_open_path(state: State<'_, AppState>) -> Option<String> {
    state.pending_open_path.lock().ok()?.take()
}

// ---------------------------------------------------------- dirty state ----

#[tauri::command]
fn set_dirty(state: State<'_, AppState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::SeqCst);
}

// ---------------------------------------------------------------- theme ----

#[derive(Serialize, Clone)]
struct ThemeInfo {
    preference: String,
    dark: bool,
}

fn normalize_theme(value: Option<&str>) -> &'static str {
    match value {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    }
}

fn theme_for(preference: &str) -> Option<Theme> {
    match preference {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None, // follow the OS
    }
}

fn stored_preference(app: &AppHandle, state: &AppState) -> &'static str {
    normalize_theme(store_read(app, state, "theme").as_ref().and_then(Value::as_str))
}

fn theme_info(window: &WebviewWindow, preference: &str) -> ThemeInfo {
    ThemeInfo {
        preference: preference.to_string(),
        dark: matches!(window.theme(), Ok(Theme::Dark)),
    }
}

#[tauri::command(async)]
fn get_theme(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> ThemeInfo {
    theme_info(&window, stored_preference(&app, &state))
}

#[tauri::command(async)]
fn set_theme(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    preference: Option<String>,
) -> CmdResult<ThemeInfo> {
    let next = normalize_theme(preference.as_deref());
    store_write(&app, &state, "theme", Value::String(next.to_string()))?;
    window.set_theme(theme_for(next)).map_err(err)?;
    Ok(theme_info(&window, next))
}

// ----------------------------------------------------------- app / menu ----

#[tauri::command]
fn get_app_info(app: AppHandle) -> HashMap<&'static str, String> {
    let pkg = app.package_info();
    HashMap::from([
        ("name", "Basic PDF".to_string()),
        ("version", pkg.version.to_string()),
        ("description", "A lightweight desktop PDF editor".to_string()),
        ("author", "barrven".to_string()),
        ("license", "MIT".to_string()),
        ("copyright", "© 2026 barrven".to_string()),
    ])
}

/// Shows a native context menu at the cursor; resolves to the chosen label,
/// or `None` when dismissed.
#[tauri::command(async)]
fn show_context_menu(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    items: Vec<String>,
) -> CmdResult<Option<String>> {
    let mut builder = MenuBuilder::new(&app);
    for (i, label) in items.iter().enumerate() {
        let item = MenuItemBuilder::with_id(format!("{MENU_ID_PREFIX}{i}"), label)
            .build(&app)
            .map_err(err)?;
        builder = builder.item(&item);
    }
    let menu = builder.build().map_err(err)?;

    let (tx, rx) = mpsc::channel::<String>();
    *state.menu_choice.lock().map_err(err)? = Some(tx);

    // popup() blocks until the menu closes and must run on the main thread.
    let (closed_tx, closed_rx) = mpsc::channel::<()>();
    let popup_window = window.as_ref().window();
    window
        .run_on_main_thread(move || {
            let _ = menu.popup(popup_window);
            let _ = closed_tx.send(());
        })
        .map_err(err)?;
    let _ = closed_rx.recv();

    // The click is delivered as a menu event just after the menu closes.
    let chosen = rx.recv_timeout(Duration::from_millis(250)).ok();
    *state.menu_choice.lock().map_err(err)? = None;

    Ok(chosen
        .and_then(|id| id.strip_prefix(MENU_ID_PREFIX)?.parse::<usize>().ok())
        .and_then(|i| items.get(i).cloned()))
}

// --------------------------------------------------------------- window ----

// The window is frameless (the renderer draws its own title bar, as it does
// under Electron's hidden title bar). bridge.js adds the caption buttons and
// drag handling and calls these.

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> CmdResult<()> {
    window.minimize().map_err(err)
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) -> CmdResult<bool> {
    if window.is_maximized().map_err(err)? {
        window.unmaximize().map_err(err)?;
        Ok(false)
    } else {
        window.maximize().map_err(err)?;
        Ok(true)
    }
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> CmdResult<bool> {
    window.is_maximized().map_err(err)
}

/// Goes through `CloseRequested`, so the unsaved-changes prompt still applies.
#[tauri::command]
fn window_close(window: WebviewWindow) -> CmdResult<()> {
    window.close().map_err(err)
}

#[tauri::command]
fn window_start_drag(window: WebviewWindow) -> CmdResult<()> {
    window.start_dragging().map_err(err)
}

fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let preference = stored_preference(app, &state);

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Basic PDF")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .theme(theme_for(preference))
        .decorations(false)
        // window.electronAPI, the equivalent of the Electron preload script.
        .initialization_script(include_str!("bridge.js"))
        // Tauri's native file-drop handler swallows HTML5 drag-and-drop on
        // Windows, which thumbnail reordering and the signature upload use.
        .disable_drag_drop_handler()
        // Stay on the bundled app; never navigate the window elsewhere.
        // Under `tauri dev` the CLI serves frontend-dist from a local dev
        // server instead of tauri.localhost, so that origin is allowed too.
        .on_navigation({
            let dev_url = app.config().build.dev_url.clone();
            move |url| {
                matches!(url.scheme(), "tauri" | "about")
                    || url.host_str() == Some("tauri.localhost")
                    || dev_url.as_ref().is_some_and(|dev| {
                        dev.scheme() == url.scheme()
                            && dev.host_str() == url.host_str()
                            && dev.port_or_known_default() == url.port_or_known_default()
                    })
            }
        })
        .build()
}

fn confirm_close_if_dirty(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = window.app_handle();
    if !app.state::<AppState>().dirty.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_close();
    let target = window.clone();
    app.dialog()
        .message("You have unsaved changes. Close without saving?")
        .title("Unsaved changes")
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close without saving".into(),
            "Cancel".into(),
        ))
        .show(move |close| {
            if close {
                target.app_handle().state::<AppState>().dirty.store(false, Ordering::SeqCst);
                let _ = target.destroy();
            }
        });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            pending_open_path: Mutex::new(pdf_path_from_args()),
            ..Default::default()
        })
        .invoke_handler(tauri::generate_handler![
            pick_open_file,
            pick_save_path,
            read_file_bytes,
            save_file,
            take_pending_open_path,
            show_context_menu,
            store_get,
            store_set,
            set_dirty,
            get_app_info,
            get_theme,
            set_theme,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            window_start_drag,
        ])
        .on_menu_event(|app, event| {
            if let Ok(guard) = app.state::<AppState>().menu_choice.lock() {
                if let Some(tx) = guard.as_ref() {
                    let _ = tx.send(event.id().as_ref().to_string());
                }
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => confirm_close_if_dirty(window, api),
            WindowEvent::ThemeChanged(theme) => {
                let app = window.app_handle();
                let preference = stored_preference(app, &app.state::<AppState>());
                let _ = app.emit(
                    "theme-updated",
                    ThemeInfo {
                        preference: preference.to_string(),
                        dark: matches!(theme, Theme::Dark),
                    },
                );
            }
            _ => {}
        })
        .setup(|app| {
            build_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Basic PDF");
}
