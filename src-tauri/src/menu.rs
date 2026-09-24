use std::collections::HashMap;
use tauri::{
    Emitter, Manager,
    menu::{
        AboutMetadata, CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem,
        Submenu, WINDOW_SUBMENU_ID,
    },
};

pub struct AppMenu(HashMap<&'static str, MenuItemKind<tauri::Wry>>);

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut items = HashMap::new();
    for (id, label, shortcut) in [
        (
            "import-folder",
            "Add Photo Folder…",
            Some("CmdOrCtrl+Shift+I"),
        ),
        ("manage-catalogs", "Manage Catalogs…", Some("CmdOrCtrl+O")),
        ("export", "Export…", Some("CmdOrCtrl+Shift+E")),
        ("open-develop", "Open in Develop", None),
        ("compare-selected", "Compare Selected Photos", None),
        ("pick", "Pick", None),
        ("reject", "Reject", None),
        ("clear-flag", "Clear Flag", None),
        ("rating-0", "Clear Rating", None),
        ("rating-1", "1 Star", None),
        ("rating-2", "2 Stars", None),
        ("rating-3", "3 Stars", None),
        ("rating-4", "4 Stars", None),
        ("rating-5", "5 Stars", None),
        ("library", "Library", None),
        ("thumbnails-smaller", "Smaller Thumbnails", None),
        ("thumbnails-larger", "Larger Thumbnails", None),
        ("preferences", "Preferences…", Some("CmdOrCtrl+,")),
    ] {
        items.insert(
            id,
            MenuItemKind::MenuItem(MenuItem::with_id(app, id, label, false, shortcut)?),
        );
    }
    for (id, label) in [
        ("grid-dynamic", "Dynamic Grid"),
        ("grid-square", "Square Grid"),
        ("sort-name", "File Name"),
        ("sort-date", "Capture Date"),
        ("sort-rating", "Rating"),
        ("sort-pick", "Pick Status"),
        ("sort-ascending", "Ascending"),
        ("sort-descending", "Descending"),
        ("auto-advance", "Auto-advance after Rating or Flagging"),
        ("show-filmstrip", "Show Filmstrip"),
        ("linked-compare", "Link Compare Zoom and Pan"),
    ] {
        items.insert(
            id,
            MenuItemKind::Check(CheckMenuItem::with_id(
                app,
                id,
                label,
                false,
                false,
                None::<&str>,
            )?),
        );
    }

    let menu = Menu::new(app)?;
    let about = PredefinedMenuItem::about(
        app,
        Some("About Darkroom"),
        Some(AboutMetadata {
            name: Some("Darkroom".into()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        }),
    )?;
    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_items(
        app,
        "Darkroom",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &items["preferences"],
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?)?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &items["import-folder"],
            &items["manage-catalogs"],
            &PredefinedMenuItem::separator(app)?,
            &items["export"],
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    {
        file.append(&PredefinedMenuItem::separator(app)?)?;
        #[cfg(target_os = "linux")]
        file.append(&MenuItem::with_id(
            app,
            "app-quit",
            "Quit Darkroom",
            true,
            Some("Ctrl+Q"),
        )?)?;
        #[cfg(not(target_os = "linux"))]
        file.append(&PredefinedMenuItem::quit(app, None)?)?;
    }
    menu.append(&file)?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    edit.append_items(&[&PredefinedMenuItem::separator(app)?, &items["preferences"]])?;
    menu.append(&edit)?;

    let ratings = Submenu::with_items(
        app,
        "Rating",
        true,
        &[
            &items["rating-0"],
            &PredefinedMenuItem::separator(app)?,
            &items["rating-1"],
            &items["rating-2"],
            &items["rating-3"],
            &items["rating-4"],
            &items["rating-5"],
        ],
    )?;
    menu.append(&Submenu::with_items(
        app,
        "Photo",
        true,
        &[
            &items["open-develop"],
            &items["compare-selected"],
            &PredefinedMenuItem::separator(app)?,
            &items["pick"],
            &items["reject"],
            &items["clear-flag"],
            &ratings,
        ],
    )?)?;

    let sort = Submenu::with_items(
        app,
        "Sort By",
        true,
        &[
            &items["sort-name"],
            &items["sort-date"],
            &items["sort-rating"],
            &items["sort-pick"],
            &PredefinedMenuItem::separator(app)?,
            &items["sort-ascending"],
            &items["sort-descending"],
        ],
    )?;
    menu.append(&Submenu::with_items(
        app,
        "View",
        true,
        &[
            &items["library"],
            &PredefinedMenuItem::separator(app)?,
            &items["grid-dynamic"],
            &items["grid-square"],
            &items["thumbnails-smaller"],
            &items["thumbnails-larger"],
            &sort,
            &PredefinedMenuItem::separator(app)?,
            &items["auto-advance"],
            &items["show-filmstrip"],
            &items["linked-compare"],
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?)?;

    #[cfg(target_os = "linux")]
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &MenuItem::with_id(app, "window-minimize", "Minimize", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "window-maximize",
                "Maximize / Restore",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "window-close", "Close Window", true, Some("Ctrl+W"))?,
        ],
    )?;
    #[cfg(not(target_os = "linux"))]
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    menu.append(&window)?;
    #[cfg(not(target_os = "macos"))]
    menu.append(&Submenu::with_items(app, "Help", true, &[&about])?)?;

    app.manage(AppMenu(items));
    app.set_menu(menu)?;
    Ok(())
}

pub fn handle_event(app: &tauri::AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    #[cfg(target_os = "linux")]
    {
        if id == "app-quit" {
            app.exit(0);
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let result = match id {
                "window-minimize" => Some(window.minimize()),
                "window-maximize" => Some(window.is_maximized().and_then(|maximized| {
                    if maximized {
                        window.unmaximize()
                    } else {
                        window.maximize()
                    }
                })),
                "window-close" => Some(window.close()),
                _ => None,
            };
            if let Some(result) = result {
                if let Err(error) = result {
                    eprintln!("Could not handle {id}: {error}");
                }
                return;
            }
        }
    }
    if app
        .try_state::<AppMenu>()
        .is_some_and(|menu| menu.0.contains_key(id))
    {
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window("main") {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if let Err(error) = app.emit_to("main", "darkroom:menu-action", id) {
            eprintln!("Could not deliver menu action {id}: {error}");
        }
    }
}

#[tauri::command]
pub async fn darkroom_menu_state(
    window: tauri::WebviewWindow,
    menu: tauri::State<'_, AppMenu>,
    enabled: HashMap<String, bool>,
    checked: HashMap<String, bool>,
) -> Result<(), String> {
    if window.label() != "main"
        || !super::trusted_url(&window.url().map_err(|error| error.to_string())?)
    {
        return Err("Untrusted desktop request.".into());
    }
    if enabled.keys().any(|id| !menu.0.contains_key(id.as_str()))
        || checked
            .keys()
            .any(|id| !matches!(menu.0.get(id.as_str()), Some(MenuItemKind::Check(_))))
    {
        return Err("Unknown menu item.".into());
    }
    for (id, enabled) in enabled {
        match &menu.0[id.as_str()] {
            MenuItemKind::MenuItem(item) => item.set_enabled(enabled),
            MenuItemKind::Check(item) => item.set_enabled(enabled),
            _ => unreachable!(),
        }
        .map_err(|error| error.to_string())?;
    }
    for (id, checked) in checked {
        if let MenuItemKind::Check(item) = &menu.0[id.as_str()] {
            item.set_checked(checked)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
