//! The OS shims that may sit outside coverage are exactly the ones in `coverage-exclude.txt`.

use std::fs;
use std::path::Path;

const MAX_LINES: usize = 80;

/// The `--ignore-filename-regex` for `cargo llvm-cov`: each listed path with both separators and a
/// literal dot, joined with `|`. ci.yml and test-runner.md build the same string with `sed`.
fn ignore_regex(listed: &[&str]) -> String {
    listed.iter().map(|p| p.replace('.', "\\.").replace('/', "[/\\]")).collect::<Vec<_>>().join("|")
}

fn problems(root: &Path) -> Vec<String> {
    let listed: Vec<String> = fs::read_to_string(root.join("coverage-exclude.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    let mut out = Vec::new();
    for path in &listed {
        match fs::read_to_string(root.join(path)) {
            Err(_) => out.push(format!("listed file missing: {path}")),
            Ok(src) if src.lines().count() > MAX_LINES => out.push(format!("over {MAX_LINES} lines: {path}")),
            Ok(_) => {}
        }
    }
    if let Ok(dir) = fs::read_dir(root.join("src/platform")) {
        for entry in dir.flatten() {
            let rel = format!("src/platform/{}", entry.file_name().to_string_lossy());
            if !listed.contains(&rel) {
                out.push(format!("unlisted file: {rel}"));
            }
        }
    }
    out
}

#[test]
fn the_platform_folder_matches_the_list() {
    assert_eq!(problems(Path::new(env!("CARGO_MANIFEST_DIR"))), Vec::<String>::new());
}

#[test]
fn the_check_catches_each_kind_of_drift() {
    let root = std::env::temp_dir().join(format!("sorot-platform-list-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("src/platform")).unwrap();
    fs::write(root.join("coverage-exclude.txt"), "src/platform/a.rs\nsrc/platform/gone.rs\nsrc/platform/big.rs\n").unwrap();
    fs::write(root.join("src/platform/a.rs"), "//! ok\n").unwrap();
    fs::write(root.join("src/platform/big.rs"), "x\n".repeat(MAX_LINES + 1)).unwrap();
    fs::write(root.join("src/platform/extra.rs"), "").unwrap();
    let mut got = problems(&root);
    got.sort();
    let _ = fs::remove_dir_all(&root);
    assert_eq!(
        got,
        [
            "listed file missing: src/platform/gone.rs",
            "over 80 lines: src/platform/big.rs",
            "unlisted file: src/platform/extra.rs",
        ]
    );
}

#[test]
fn the_ignore_regex_matches_both_separators_and_literal_dots() {
    assert_eq!(
        ignore_regex(&["src/platform/reveal.rs", "src/platform/tray.rs"]),
        r"src[/\]platform[/\]reveal\.rs|src[/\]platform[/\]tray\.rs"
    );
}
