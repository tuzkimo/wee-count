// src-tauri/src/screenshot.rs
//! 截屏防护：开关 Android 的 `FLAG_SECURE`，桌面端为 no-op。
//!
//! 这里刻意把「选哪个标志位、调哪个方法」抽成与平台无关的纯函数放在 `cfg` 门之外，
//! 让宿主（Windows）上的 `cargo check` / `cargo test` 能真正类型检查并覆盖它；
//! 只有 `android.view.Window` 的 JNI 调用本身关在 `#[cfg(target_os = "android")]` 里。
//!
//! 门外的这几项只在 Android 分支里被引用，非 Android 构建会报 dead_code；
//! 它们本来就是有意的跨平台共享核心，用 `cfg_attr` 按目标静音，别删。

/// 在非 Android 目标上静音 dead_code：下列各项只被 Android 分支使用。
macro_rules! used_on_android_only {
    ($item:item) => {
        #[cfg_attr(not(target_os = "android"), allow(dead_code))]
        $item
    };
}

used_on_android_only! {
    /// `android.view.WindowManager.LayoutParams.FLAG_SECURE`。
    ///
    /// 置位后系统截屏得到空白画面，且最近任务列表不显示该窗口的内容缩略图。
    /// 取值来自 AOSP，是长期稳定的公开常量。
    pub const FLAG_SECURE: i32 = 0x0000_2000;
}

used_on_android_only! {
    /// 开关防护时分别要调的 `android.view.Window` 方法名。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum FlagAction {
        /// 置位 `FLAG_SECURE`。
        Add,
        /// 清除 `FLAG_SECURE`。
        Clear,
    }
}

used_on_android_only! {
    impl FlagAction {
        /// 取对应的 `android.view.Window` 方法名。
        pub fn method_name(self) -> &'static str {
            match self {
                FlagAction::Add => "addFlags",
                FlagAction::Clear => "clearFlags",
            }
        }
    }
}

used_on_android_only! {
    /// `enabled == true` 就置位，否则清除。
    pub fn flag_action(enabled: bool) -> FlagAction {
        if enabled {
            FlagAction::Add
        } else {
            FlagAction::Clear
        }
    }
}

used_on_android_only! {
    /// 把 `FlagAction` 落成 `(方法名, 标志位)`，两个平台分支共用同一份决策。
    pub fn flag_call(enabled: bool) -> (&'static str, i32) {
        (flag_action(enabled).method_name(), FLAG_SECURE)
    }
}

used_on_android_only! {
    /// 把 JNI 侧的错误统一成 `String`，避免桌面端也要认识 `jni::errors::Error`。
    pub fn describe_error(error: impl std::fmt::Display) -> String {
        format!("设置 FLAG_SECURE 失败: {error}")
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::{describe_error, flag_call};
    use jni::objects::JValue;
    use tauri::WebviewWindow;

    /// 在 Android 上开关 `FLAG_SECURE`。
    ///
    /// 必须拿到真实 Activity 才能改窗口标志位，所以走
    /// `WebviewWindow::with_webview` + `JniHandle::exec`。
    pub fn set(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
        let (method, flag) = flag_call(enabled);

        window
            .with_webview(move |webview| {
                // JniHandle::exec 的回调签名：
                // (&mut JNIEnv, &JObject /* activity */, &JObject /* webview */)
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let result = (|| -> jni::errors::Result<()> {
                        let window_obj = env
                            .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?
                            .l()?;
                        env.call_method(&window_obj, method, "(I)V", &[JValue::Int(flag)])?;
                        Ok(())
                    })();

                    // 单次开关失败不该让 App 崩掉，记一笔日志即可。
                    if let Err(e) = result {
                        eprintln!("[screenshot] {}", describe_error(e));
                    }
                });
            })
            .map_err(|e| format!("无法访问 WebView: {e}"))
    }
}

#[cfg(target_os = "android")]
pub use android::set;

/// 桌面端（含开发调试用的一切非 Android 目标）：没有对应能力，安全地什么都不做。
///
/// 不返回 `Err`——桌面端不存在「防护失败」，谎报失败会让前端弹一个无从修复的错误。
#[cfg(not(target_os = "android"))]
pub fn set(_window: &tauri::WebviewWindow, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_secure_matches_aosp_value() {
        assert_eq!(FLAG_SECURE, 0x2000);
    }

    #[test]
    fn enabled_maps_to_add_flags() {
        assert_eq!(flag_call(true), ("addFlags", FLAG_SECURE));
    }

    #[test]
    fn disabled_maps_to_clear_flags() {
        assert_eq!(flag_call(false), ("clearFlags", FLAG_SECURE));
    }

    #[test]
    fn action_is_exhaustive_over_bool() {
        assert_eq!(flag_action(true), FlagAction::Add);
        assert_eq!(flag_action(false), FlagAction::Clear);
    }

    #[test]
    fn error_message_keeps_original_cause() {
        let message = describe_error("jni: null pointer");
        assert!(message.contains("jni: null pointer"), "实际: {message}");
        assert!(message.contains("FLAG_SECURE"), "实际: {message}");
    }
}
