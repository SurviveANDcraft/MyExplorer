#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dirsize;
mod error;
mod fs;
mod images;
mod index;
mod launch;
mod predict;
mod shellops;
mod sta;
mod types;
mod util;
mod watch;

use tauri::Manager;

fn main() {
    // Keep the WebView2 profile next to the rest of the app's data (one folder to manage).
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", util::data_dir().join("webview"));
    }
    let argv: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    launch::set_initial(launch::parse(&argv, &cwd));
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch hands its args over and exits immediately.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| launch::on_second_instance(app, argv, cwd)))
        .register_asynchronous_uri_scheme_protocol("icon", |_ctx, req, responder| {
            let uri = req.uri().to_string();
            sta::SHELL.spawn(move || responder.respond(images::icon_response(&uri)));
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |_ctx, req, responder| {
            let uri = req.uri().to_string();
            sta::THUMBS.spawn(move || responder.respond(images::thumb_response(&uri)));
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_dir,
            commands::get_drives,
            commands::get_known_folders,
            commands::stat,
            commands::type_names,
            commands::list_subdirs,
            commands::dir_size,
            commands::cancel_dir_size,
            commands::read_text,
            commands::watch_dir,
            commands::unwatch_dir,
            commands::create_folder,
            commands::create_file,
            commands::rename,
            commands::delete,
            commands::transfer,
            commands::undo,
            commands::redo,
            commands::open,
            commands::open_with,
            commands::show_properties,
            commands::open_terminal,
            commands::clipboard_write_files,
            commands::clipboard_read_files,
            commands::search,
            commands::index_status,
            commands::record_visit,
            commands::get_frecent,
            commands::suggest_destinations,
            commands::suggest_next,
            commands::load_settings,
            commands::save_settings,
            commands::take_launch,
        ])
        .setup(|app| {
            let _ = util::APP.set(app.handle().clone());
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(h) = w.hwnd() {
                    util::set_main_hwnd(h.0 as isize);
                }
                // Safety net: the UI shows the window after first paint; never stay invisible.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            index::warmup();
            index::start();
            std::thread::spawn(|| {
                let _ = &*fs::HOME;
                predict::version();
                predict::frecency_snapshot();
            });
            Ok(())
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|_app, ev| {
            if let tauri::RunEvent::Exit = ev {
                predict::flush();
                index::shutdown();
            }
        }),
        Err(e) => {
            eprintln!("failed to start MyExplorer: {e}");
            std::process::exit(1);
        }
    }
}
