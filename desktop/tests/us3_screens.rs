//! L2 for User Story 3: the no-GPU path and the beam's light, in process against fakes.


use std::sync::Arc;

use sorot_desktop::app::Msg;
use sorot_desktop::ui::fx_moments::{Look, Moment, Placed, layers};
use crate::support::*;

fn layers_drawn(rt: &rune::Runtime<sorot_desktop::app::State>, t: f32, look: Look) -> usize {
    slots(rt).into_iter().map(|(moment, data)| layers(Placed { moment, data, rect: rune_fx::Rect::new(0.0, 0.0, 24.0, 24.0), scale: 1.0 }, t, look).len()).sum()
}

/// A machine with a GPU or a CPU renderer: the notice, the layers drawn (blur and glow), the preview route.
#[test]
fn a_cpu_renderer_shows_one_notice_draws_no_effects_and_previews_in_the_player() {
    for (software, notice, glass_layers, opened) in [(false, false, 2, 0), (true, true, 0, 1)] {
        let reveal = Arc::new(RecordReveal::default());
        let mut state = sorot_desktop::app::State::scene("clips-ranked");
        state.reveal = Some(reveal.clone());
        state.apply(Msg::Gpu { software });
        state.show_clips("vnew");
        let mut rt = runtime_of(state);
        assert_eq!(rt.find("shell/gpu-notice").is_some(), notice, "software={software}");
        let look = Look { reduced: false, cpu: rt.state.cpu_renderer };
        let glass = slots(&rt).iter().filter(|(m, _)| m.is_glass()).count();
        assert_eq!((glass, layers_drawn(&rt, 5.0, look)), (1, glass_layers.min(1)), "software={software}");
        click(&mut rt, "clips/play");
        assert_eq!(reveal.opened.lock().unwrap().len(), opened, "software={software}");
        if notice {
            click(&mut rt, "shell/gpu-notice/dismiss");
            assert!(rt.find("shell/gpu-notice").is_none() && rt.state.cpu_renderer);
        }
    }
}

/// The head's light warms when the engine reports progress (the job opening is the first report)
/// and cools once the reports stop; reduced motion holds one level and then none.
#[test]
fn the_beam_warms_on_progress_and_cools_when_idle() {
    for reduced in [false, true] {
        let mut rt = scene_rt("job-running");
        let radius = |rt: &rune::Runtime<_>, t: f32| {
            let (moment, data) = slots(rt).into_iter().find(|(m, _)| *m == Moment::BeamHead).expect("one beam head");
            match layers(Placed { moment, data, rect: rune_fx::Rect::new(0.0, 0.0, 10.0, 10.0), scale: 1.0 }, t, Look { reduced, cpu: false })[0].fx {
                rune_fx::Fx::Glow(g) => g.radius,
                _ => unreachable!(),
            }
        };
        let mut seen = vec![];
        for t in [0.3, 1.5, 14.0] {
            rt.update(move |s, _| {
                s.tick(t);
            });
            rt.invalidate();
            rt.frame(1.0 / 60.0);
            seen.push(radius(&rt, t as f32));
        }
        let want = if reduced { [13.6, 13.6, 4.0] } else { [seen[0], seen[1], seen[2]] };
        assert_eq!(seen, want, "reduced={reduced}");
        assert!(reduced || (seen[0] > 12.0 && seen[1] > seen[2] && seen[2] < 6.0), "{seen:?}");
    }
}

fn name_of(rt: &rune::Runtime<sorot_desktop::app::State>, key: &str) -> String {
    fn find(v: &serde_json::Value, key: &str) -> Option<String> {
        if v["key"] == key {
            return v["name"].as_str().map(String::from);
        }
        v["children"].as_array()?.iter().find_map(|c| find(c, key))
    }
    find(&rt.accessibility_json(), key).unwrap_or_else(|| panic!("no {key}"))
}

/// The menu bar and the rail speak Indonesian by default and English on request, through the i18n files.
#[test]
fn the_shell_speaks_the_chosen_language() {
    use sorot_desktop::i18n::{Lang, tr};
    for lang in [Lang::Id, Lang::En] {
        let mut state = sorot_desktop::app::State::scene("clips-ranked");
        state.lang = lang;
        state.show_clips("vnew");
        let rt = runtime_of(state);
        for (key, words) in [("shell/menu/file", "menu.file"), ("shell/menu/help", "menu.help"), ("shell/rail/home", "shell.home"), ("shell/rail/clips", "shell.clips"), ("shell/rail/settings", "shell.settings")] {
            assert_eq!(name_of(&rt, key), tr(lang, words), "{lang:?} {key}");
        }
    }
    assert_eq!(sorot_desktop::app::State::default().lang, Lang::Id);
}

/// A menu opens under the bar, an item does what its destination does and closes the list; the View menu lists the rail's places.
#[test]
fn the_menus_open_run_and_close() {
    let mut rt = scene_rt("clips-ranked");
    assert!(rt.find("shell/menu-list").is_none());
    click(&mut rt, "shell/menu/view");
    assert!(rt.find("shell/menu-list").is_some() && rt.find("shell/menu/view/settings").is_some());
    click(&mut rt, "shell/menu/view/settings");
    assert!(rt.find("shell/menu-list").is_none());
    assert_eq!(rt.state.screen(), sorot_desktop::app::Screen::Connections);
    click(&mut rt, "shell/menu/view");
    click(&mut rt, "shell/menu/view/theme");
    assert!(!rt.state.dark);
    click(&mut rt, "shell/menu/file");
    click(&mut rt, "shell/menu/file/new");
    assert_eq!(rt.state.screen(), sorot_desktop::app::Screen::Home);
    click(&mut rt, "shell/menu/edit");
    click(&mut rt, "shell/menu/edit/edit-clip");
    assert_eq!(rt.state.screen(), sorot_desktop::app::Screen::Editor);
    click(&mut rt, "shell/menu/window");
    click(&mut rt, "shell/menu/window/hide");
    click(&mut rt, "shell/menu/help");
    click(&mut rt, "shell/menu/help");
    assert!(rt.find("shell/menu-list").is_none());
}
