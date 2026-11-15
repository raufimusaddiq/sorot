//! What the screen tests share. L1 is `desktop/core`; L2 drives a Rune `Runtime` in process against
//! `FakeEngine` (these helpers); L3 runs the binary headless (`headless`).
#![allow(dead_code)]

use rune::{Env, Key, KeyEvent, Mods, Runtime};
use sorot_desktop::app::State;

#[allow(unused_imports)]
pub use sorot_desktop::engine::fake::{FakeClock, FakeEngine, FakeProc, FakeSpawn, RecordNotifier, RecordReveal};

pub mod headless;

/// The app on scene `name`, one frame in, at a desktop window size.
pub fn runtime(name: &str) -> Runtime<State> {
    runtime_of(State::scene(name))
}

pub fn runtime_of(state: State) -> Runtime<State> {
    let mut rt = Runtime::new(state, sorot_desktop::app::view, (1100.0, 720.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt
}

/// Presses the element with `key` as a pointer would, then lets one frame pass.
pub fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no element {key}"));
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

/// Moves the pointer onto (or off) the element with `key`.
pub fn hover(rt: &mut Runtime<State>, key: Option<&str>) {
    rt.pointer_move(1.0, 1.0);
    rt.frame(1.0 / 60.0);
    if let Some(k) = key {
        let (x, y) = rt.find(k).unwrap_or_else(|| panic!("no element {k}"));
        rt.pointer_move(x, y);
        rt.frame(1.0 / 60.0);
    }
}

/// Types `s` into the focused field (focus it first with `click`).
pub fn type_text(rt: &mut Runtime<State>, key: &str, s: &str) {
    click(rt, key);
    rt.key(KeyEvent { key: Key::Text(s.into()), mods: Mods::default() });
    rt.frame(1.0 / 60.0);
}

/// A chord such as `cmd+k` or `Enter`.
pub fn press(rt: &mut Runtime<State>, chord: &str) {
    let parts: Vec<&str> = chord.split('+').collect();
    let (name, mods) = parts.split_last().unwrap();
    let mods = Mods {
        cmd: mods.contains(&"cmd") || mods.contains(&"ctrl"),
        shift: mods.contains(&"shift"),
        alt: mods.contains(&"alt"),
        ..Mods::default()
    };
    let key = match *name {
        "Enter" => Key::Enter,
        "Escape" => Key::Escape,
        "Tab" => Key::Tab,
        n if n.chars().count() == 1 && mods.cmd => Key::Command(n.chars().next().unwrap().to_ascii_lowercase()),
        n => Key::Text(n.into()),
    };
    rt.key(KeyEvent { key, mods });
    rt.frame(1.0 / 60.0);
}

/// Seconds of app time pass in 60 fps frames.
pub fn advance(rt: &mut Runtime<State>, seconds: f64) {
    let mut t = 0.0;
    while t < seconds {
        rt.frame(1.0 / 60.0);
        t += 1.0 / 60.0;
    }
}

/// A `Live` launch around `sup`: a library that finds nothing and a tray that is never installed.
pub fn live_of(sup: sorot_desktop::app::Supervisor) -> sorot_desktop::app::Live {
    use sorot_desktop::library::SceneLibrary;
    let dir = sorot_desktop::engine::fake::scenes_dir().join("first-run");
    sorot_desktop::app::Live {
        supervisor: sup,
        library: std::sync::Arc::new(SceneLibrary::new(dir)),
        config_dir: std::env::temp_dir().join("sorot-test-config"),
        saved: None,
        data_dir: "data".into(),
        tray: std::sync::Arc::new(FakeTray::default()),
        reveal: std::sync::Arc::new(RecordReveal::default()),
        notifier: std::sync::Arc::new(RecordNotifier::default()),
        preview: || Box::new(sorot_desktop::preview::NullPreview::default()),
        gpu: std::sync::Arc::new(FakeGpu(false)),
    }
}

type TrayCallback = std::sync::Arc<dyn Fn(sorot_desktop::platform::tray::TrayCmd) + Send + Sync>;

/// A tray that remembers the callback it was given.
#[derive(Default)]
pub struct FakeTray {
    pub installed: std::sync::Mutex<Option<TrayCallback>>,
    pub works: bool,
}

impl sorot_desktop::platform::tray::Tray for FakeTray {
    fn install(&self, on: TrayCallback) -> bool {
        *self.installed.lock().unwrap() = Some(on);
        self.works
    }
}

/// A GPU probe with a fixed answer: `true` is a CPU renderer.
pub struct FakeGpu(pub bool);

impl sorot_desktop::platform::gpu_probe::GpuProbe for FakeGpu {
    fn software(&self) -> bool {
        self.0
    }
}

/// Every effect slot the frame drew: its moment and payload (what the compositor would be handed).
pub fn slots(rt: &Runtime<State>) -> Vec<(sorot_desktop::ui::fx_moments::Moment, [f32; 4])> {
    rt.instances
        .iter()
        .filter(|i| i.params[1] == rune::render::KIND_EFFECT)
        .filter_map(|i| {
            let mark = (i.border[0] as u32 & 0xFFFF) | (i.border[1] as u32 & 0xFFFF) << 16;
            sorot_desktop::ui::fx_moments::Moment::from_mark(mark).map(|m| (m, i.uv))
        })
        .collect()
}

/// Runs `f` on the state and frames once.
pub fn poke(rt: &mut Runtime<State>, f: impl FnOnce(&mut State) + Send + 'static) {
    rt.update(move |s, _| f(s));
    rt.frame(1.0 / 60.0);
}

/// The app's scenes by name, as `Runtime`s on the scene's own screen.
pub fn scene_rt(name: &str) -> Runtime<State> {
    let (_, build) = sorot_desktop::app::SCENES.iter().find(|(n, _)| *n == name).unwrap_or_else(|| panic!("no scene {name}"));
    let mut state = State::default();
    build(&mut state);
    runtime_of(state)
}
