//! The design's limits (R-10, R-13, R-19), held on every screen: glass only on the palette and the
//! transport bar (two at most), glow only on the beam head (two at most), one-shots only at their
//! moments, no blur anywhere else, and no layer animating at rest.


use rune::render::{KIND_BACKDROP_BLUR, KIND_EFFECT};
use sorot_desktop::app::{Msg, SCENES, State};
use sorot_desktop::engine::Engine;
use sorot_desktop::ui::fx_moments::{Look, Moment, Placed, animating};
use crate::support::*;

fn rested(name: &str, dark: bool) -> rune::Runtime<State> {
    let mut state = State::default();
    SCENES.iter().find(|(n, _)| *n == name).unwrap().1(&mut state);
    state.dark = dark;
    runtime_of(state)
}

fn tally(rt: &rune::Runtime<State>) -> (usize, usize, usize, usize) {
    let all = slots(rt);
    let n = |f: fn(Moment) -> bool| all.iter().filter(|(m, _)| f(*m)).count();
    (n(|m| m.is_glass()), n(|m| m.is_glow()), n(|m| m.is_one_shot()), rt.instances.iter().filter(|i| i.params[1] == KIND_BACKDROP_BLUR).count())
}

/// Every scene in both themes at rest: (glass, glow, one-shots, other blurs) within limits, nothing animating.
#[test]
fn every_screen_keeps_the_limits_and_rests() {
    for name in SCENES.iter().map(|(n, _)| *n) {
        for dark in [true, false] {
            let rt = rested(name, dark);
            let (glass, glow, shots, blurs) = tally(&rt);
            assert!(glass <= 2 && glow <= 2 && shots == 0 && blurs == 0, "{name} dark={dark}: {:?}", (glass, glow, shots, blurs));
            for (moment, data) in slots(&rt) {
                let placed = Placed { moment, data, rect: rune_fx::Rect::new(0.0, 0.0, 24.0, 24.0), scale: 1.0 };
                assert!(!animating(placed, 1000.0, Look::default()), "{name}: {moment:?} animates at rest");
            }
            assert!(rt.instances.iter().filter(|i| i.params[1] == KIND_EFFECT).count() <= 4, "{name}");
        }
    }
    // The job screen has the one glow, the clips screen the one glass; the editor has neither (its stage has no transport bar, its hook is a plain marker).
    let counts: Vec<_> = ["job-running", "clips-ranked", "editor-hook", "home-empty"].map(|n| (tally(&rested(n, true)).0, tally(&rested(n, true)).1)).into();
    assert_eq!(counts, [(0, 1), (1, 0), (0, 0), (0, 0)]);
}

/// A finished stage rings once, for its 0.6 s, and the ring is gone after; nothing else moves.
#[test]
fn a_stage_ring_exists_only_for_its_moment() {
    let mut detail = sorot_desktop::engine::fake::FakeEngine::scene("job-running").job("j1").unwrap();
    detail.stages[4].status = "COMPLETED".into();
    detail.stages[5].status = "IN_PROGRESS".into();
    let mut rt = rested("job-running", true);
    rt.update(move |s, _| {
        s.tick(5.0);
        s.apply(Msg::JobDetail(detail));
    });
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    let during = tally(&rt).2;
    rt.update(|s, _| {
        s.tick(6.0);
    });
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert_eq!((during, tally(&rt).2), (1, 0));
}
