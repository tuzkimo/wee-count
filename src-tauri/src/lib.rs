mod screenshot;

/// 开关截屏防护。
///
/// **必须是 `async`（线程池执行）**：Android 分支要等 JNI 回调把结果送回来，
/// 而那个回调是在 Android 主线程上执行的（见 `screenshot.rs`）。默认的
/// 「同步 command 跑在主线程」会让这里等自己，永远等不到结果；
/// `#[tauri::command(async)]` 把函数体放到线程池，主线程才能腾出来跑回调。
#[tauri::command(async)]
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
