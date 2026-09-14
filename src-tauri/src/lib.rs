mod screenshot;

#[tauri::command]
fn set_screenshot_protection(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    screenshot::set(&window, enabled)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![set_screenshot_protection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
