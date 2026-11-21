#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod agent_setup;
mod archive;
mod commands;
mod dirsize;
mod disk;
mod error;
mod fs;
mod grep;
mod images;
mod index;
mod integration;
mod launch;
mod predict;
mod shellmenu;
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
    // Headless search server for the `mx` CLI (no window, no single-instance handoff).
    if argv.iter().skip(1).any(|a| a == "--mx-daemon") {
        agent::run_daemon();
    }
    // Scripted agent setup (same as Settings → AI agents); the uninstaller uses --agents-uninstall.
    if let Some(code) = agent_setup::cli(&argv) {
        std::process::exit(code);
    }
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    launch::set_initial(launch::parse(&argv, &cwd));
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch hands its args over and exits immediately.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| launch::on_second_instance(app, argv, cwd)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            commands::shell_menu_open,
            commands::shell_menu_invoke,
            commands::shell_menu_close,
            commands::drag_out,
            commands::compress,
            commands::extract,
            commands::cancel_archive,
            commands::grep,
            commands::cancel_grep,
            commands::integration_status,
            commands::set_integration,
            commands::hotkey_free,
            commands::agents_status,
            commands::set_agent,
            commands::agents_prompt,
            commands::prepare_update,
            commands::release_single_instance_lock,
            commands::open_notices,
            commands::invalidate_dir_sizes,
            commands::disk_tree,
            commands::disk_suggest,
            commands::disk_forget,
            commands::disk_release,
            commands::recycle_bin_info,
            commands::empty_recycle_bin,
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
            agent::start_gui();
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
