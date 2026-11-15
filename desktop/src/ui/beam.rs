//! The beam motif as one component: a bar whose fill falls off like light, with grain on the fill
//! only, and a head that glows with the beam's heat. Variants differ in thickness and where they sit:
//! `Stage` (the job's stage track), `Clip` (a clip's score), `Hook` (the hook on the timeline) and
//! `Action` (under the one primary action). There is at most one beam on a screen.
//!
//! The head is a hot dot over a `BeamHead` effect slot: the compositor draws the glow under the
//! dot, and a machine without one still shows the dot. The glow follows `heat` (0 cool, 1 hot),
//! which the screen feeds from a `Heat` light: it warms when the engine reports `PROGRESS` and
//! cools when the stage idles.

use std::cell::Cell;
use std::f32::consts::FRAC_PI_2;

use rune::{El, col};
use rune_fx::Heat;

use crate::ui::fx_moments::{Moment, slot};
use crate::ui::kit::pal;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Stage,
    Clip,
    Hook,
    Action,
}

impl Variant {
    pub fn thickness(self) -> f32 {
        match self {
            Variant::Stage => 4.0,
            Variant::Clip | Variant::Hook => 3.0,
            Variant::Action => 2.0,
        }
    }
}

/// The light a beam head follows: quick attack as `PROGRESS` arrives, about 1.5 s to cool.
pub fn heat_light() -> Heat {
    Heat::new(0.25, 0.65)
}

thread_local! {
    static ON_SCREEN: Cell<u32> = const { Cell::new(0) };
}

/// A new screen is being built: no beam has been placed yet.
pub fn begin_screen() {
    ON_SCREEN.with(|n| n.set(0));
}

/// `length` is the lit part in points; `heat` is 0 to 1; `label` is what a screen reader hears.
pub fn beam(dark: bool, key: &str, variant: Variant, length: f32, heat: f32, label: impl Into<String>) -> El {
    ON_SCREEN.with(|n| {
        n.set(n.get() + 1);
        debug_assert!(n.get() <= 1, "one beam per screen (second one: {key})");
    });
    let p = pal(dark);
    let (h, length) = (variant.thickness(), length.max(0.0));
    // Light falls off toward the tail; the grain sits on the fill alone.
    let body = col().w(length).h(h).radius(h / 2.0).fill(p.beam).linear_gradient(FRAC_PI_2, [(0.0, p.beam.alpha(0.15)), (1.0, p.beam)])
        .absolute(0.0, 5.0)
        .child(slot(Moment::BeamBody, [0.0; 4]).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)));
    let x = (length - 5.0).max(0.0);
    let glow = slot(Moment::BeamHead, [heat, 0.0, 0.0, 0.0]).w(10.0).h(10.0).absolute(x, 2.0);
    let head = col().w(10.0).h(10.0).radius(5.0).fill(p.beam).absolute(x, 2.0);
    col().key(key).role("progressbar").label(label).w(length + 10.0).h(14.0).child(body).child(glow).child(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The light warms quickly when progress arrives and cools to nothing when it stops.
    #[test]
    fn the_light_warms_on_progress_and_cools_when_idle() {
        let mut light = heat_light();
        light.set(1.0, true);
        let warm = light.at(1.3);
        assert!(warm > 0.95 && light.is_active(1.1) && !light.is_active(1.3));
        light.set(2.0, false);
        let cooling: Vec<f32> = [2.5, 3.5, 6.0].iter().map(|t| light.at(*t)).collect();
        assert!(cooling[0] > cooling[1] && cooling[1] > cooling[2] && cooling[2] < 0.02 && !light.is_active(7.0));
    }

    #[test]
    fn a_second_beam_on_one_screen_is_refused_in_debug() {
        begin_screen();
        let _ = beam(true, "a", Variant::Stage, 40.0, 0.0, "a");
        let second = std::panic::catch_unwind(|| beam(true, "b", Variant::Hook, 40.0, 0.0, "b"));
        assert!(second.is_err());
        begin_screen();
        let _ = beam(true, "c", Variant::Action, 0.0, 1.0, "c");
        assert_eq!([Variant::Stage, Variant::Clip, Variant::Hook, Variant::Action].map(Variant::thickness), [4.0, 3.0, 3.0, 2.0]);
    }
}
