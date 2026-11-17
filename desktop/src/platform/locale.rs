//! OS shim: the language the OS is set to, as a tag such as `id-ID` or `en_US.UTF-8`.
//! Kept thin and out of coverage (coverage-exclude.txt); the rule that reads it is `general::lang_of`.

/// `None` when the OS does not say.
pub fn os_locale() -> Option<String> {
    #[cfg(windows)]
    {
        let mut buf = [0u16; 85];
        // SAFETY: the buffer is LOCALE_NAME_MAX_LENGTH (85) wide, as the call requires.
        let n = unsafe { windows_sys::Win32::Globalization::GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        return (n > 1).then(|| String::from_utf16_lossy(&buf[..n as usize - 1]));
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("defaults").args(["read", "-g", "AppleLocale"]).output().ok()?;
        return Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty() && v != "C" && v != "POSIX"))
    }
}
