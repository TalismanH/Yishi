pub fn open(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    open_browser(url.as_str());
}

#[cfg(windows)]
fn open_browser(url: &str) {
    use std::ffi::c_void;
    use std::ptr::null;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> *mut c_void;
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let address: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    // ShellExecute opens an URL through Windows; never interpolate it into a shell command.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            address.as_ptr(),
            null(),
            null(),
            1,
        )
    } as isize;
    if result <= 32 {
        eprintln!("无法打开外部链接（Windows 错误 {result}）");
    }
}

#[cfg(not(windows))]
fn open_browser(url: &str) {
    let command = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    if let Err(error) = std::process::Command::new(command).arg(url).spawn() {
        eprintln!("无法打开外部链接：{error}");
    }
}
