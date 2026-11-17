//! L3: the real binary, headless. `run` starts it on a scene, optionally plays a script, and reads
//! back the element tree it dumps; the other helpers ask that tree questions.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;

pub struct Tree(pub Value);

static N: AtomicU32 = AtomicU32::new(0);

fn temp(ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!("sorot-headless-{}-{}.{ext}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)))
}

/// How long one headless process may run. Generous: a loaded CI runner is slow, and the suite's own
/// timeout is the real bound.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);

/// Runs `cmd` to the end, or kills it after `DEADLINE` and fails with what it printed.
fn finish(mut cmd: Command) -> std::process::Output {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let reader = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = r.read_to_end(&mut b);
            b
        })
    };
    let (o, e) = (reader(Box::new(out)), reader(Box::new(err)));
    let deadline = std::time::Instant::now() + DEADLINE;
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the headless binary did not exit in {} s: {}", DEADLINE.as_secs(), String::from_utf8_lossy(&e.join().unwrap()));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    std::process::Output { status, stdout: o.join().unwrap(), stderr: e.join().unwrap() }
}

fn binary() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_sorot-desktop"));
    c.env("RUNE_PERF_WARN", "0");
    c
}

/// The binary's stdout for `args`.
pub fn output(args: &[&str]) -> String {
    let out = finish({ let mut c = binary(); c.args(args); c });
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Runs `scene`, plays `desktop/scripts/headless/{script}.json` if given and dumps the tree at its
/// last mark.
pub fn run(scene: &str, script: Option<&str>, args: &[&str]) -> Tree {
    run_env(scene, script, args, &[])
}

/// As `run`, with extra environment variables for the binary.
pub fn run_env(scene: &str, script: Option<&str>, args: &[&str], env: &[(&str, &Path)]) -> Tree {
    run_at(scene, script, "end", args, env)
}

/// As `run_env`, with the tree dumped at the script's mark `mark`.
pub fn run_at(scene: &str, script: Option<&str>, mark: &str, args: &[&str], env: &[(&str, &Path)]) -> Tree {
    let tree = temp("json");
    let mut cmd = binary();
    cmd.envs(env.iter().copied());
    cmd.args(["--scene", scene, "--tree"]).arg(&tree);
    if let Some(name) = script {
        cmd.arg("--script").arg(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("scripts/headless/{name}.json"))).args(["--at", &format!("mark:{mark}")]);
    }
    let out = finish({ cmd.args(args); cmd });
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let parsed = serde_json::from_str(&std::fs::read_to_string(&tree).unwrap()).unwrap();
    let _ = std::fs::remove_file(&tree);
    Tree(parsed)
}

/// A fresh folder under the temp dir.
pub fn temp_dir() -> PathBuf {
    let dir = temp("d");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A PNG of `scene` in `theme` (`dark` or `light`) at `size` (`1100x720`).
pub fn snap(scene: &str, theme: &str, size: &str) -> PathBuf {
    let png = temp("png");
    let mut cmd = binary();
    cmd.args(["--scene", scene, "--theme", theme, "--size", size, "--scale", "1", "--snap"]).arg(&png);
    let out = finish(cmd);
    assert!(out.status.success() && png.metadata().is_ok_and(|m| m.len() > 0), "{}", String::from_utf8_lossy(&out.stderr));
    png
}

fn elements(tree: &Tree) -> &Vec<Value> {
    tree.0["elements"].as_array().expect("the tree has elements")
}

/// The element with `key`.
pub fn node<'a>(tree: &'a Tree, key: &str) -> &'a Value {
    elements(tree).iter().find(|e| e["key"] == key).unwrap_or_else(|| panic!("no element {key}"))
}

fn name_of(n: &Value, key: &str) -> Option<String> {
    if n["key"] == key {
        return n["name"].as_str().map(String::from);
    }
    n["children"].as_array()?.iter().find_map(|c| name_of(c, key))
}

/// What a screen reader hears for `key`.
pub fn name(tree: &Tree, key: &str) -> String {
    name_of(&tree.0["accessibility"], key).unwrap_or_else(|| panic!("no accessible name for {key}"))
}

/// The text of `key` is exactly `want`.
pub fn assert_text(tree: &Tree, key: &str, want: &str) {
    assert_eq!(node(tree, key)["text"].as_str().map(str::to_string).unwrap_or_else(|| name(tree, key)), want, "{key}");
}

/// `key` has a role and a name.
pub fn assert_role_label(tree: &Tree, key: &str) {
    let role = node(tree, key)["role"].as_str().unwrap_or_default();
    assert!(!role.is_empty() && role != "group" && !name(tree, key).is_empty(), "{key} needs a role and a name");
}

fn rect(e: &Value) -> [f64; 4] {
    let r = e["rect"].as_array().unwrap();
    [r[0].as_f64().unwrap(), r[1].as_f64().unwrap(), r[2].as_f64().unwrap(), r[3].as_f64().unwrap()]
}

fn key_or_path(e: &Value) -> String {
    e["key"].as_str().or(e["path"].as_str()).unwrap().to_string()
}

/// Pairs of controls that cover each other (neither inside the other).
pub fn overlaps(tree: &Tree) -> Vec<(String, String)> {
    let controls: Vec<&Value> = elements(tree).iter().filter(|e| e["focusable"] == true).collect();
    let mut out = vec![];
    for (i, a) in controls.iter().enumerate() {
        for b in &controls[i + 1..] {
            let (pa, pb) = (a["path"].as_str().unwrap(), b["path"].as_str().unwrap());
            if pa.starts_with(pb) || pb.starts_with(pa) {
                continue;
            }
            let (ra, rb) = (rect(a), rect(b));
            if ra[0] < rb[0] + rb[2] && rb[0] < ra[0] + ra[2] && ra[1] < rb[1] + rb[3] && rb[1] < ra[1] + ra[3] {
                out.push((key_or_path(a), key_or_path(b)));
            }
        }
    }
    out
}

/// Text that spills outside the window or its parent's box. Content inside a scrolling area (a keyed
/// `.../scroll`) may run past the window's edge: it scrolls.
pub fn clipped_text(tree: &Tree) -> Vec<String> {
    let els = elements(tree);
    let (w, h) = (tree.0["viewport"][0].as_f64().unwrap(), tree.0["viewport"][1].as_f64().unwrap());
    let outside = |inner: [f64; 4], outer: [f64; 4]| {
        inner[0] < outer[0] - 0.5 || inner[1] < outer[1] - 0.5 || inner[0] + inner[2] > outer[0] + outer[2] + 0.5 || inner[1] + inner[3] > outer[1] + outer[3] + 0.5
    };
    els.iter()
        .filter(|e| e["text"].is_string())
        .filter(|e| {
            let path = e["path"].as_str().unwrap();
            let parent = path.rsplit_once('/').and_then(|(p, _)| els.iter().find(|o| o["path"] == p));
            (!path.contains("/scroll/") && outside(rect(e), [0.0, 0.0, w, h])) || parent.is_some_and(|p| outside(rect(e), rect(p)))
        })
        .map(key_or_path)
        .collect()
}
