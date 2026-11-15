//! The signature moments, mapped onto Rune's real `rune-fx` layers (design.md "rune-fx: signature
//! moments", `design/fx.md`). A view puts an effect slot where a moment happens (`slot`); the
//! compositor in `platform/fx_compositor.rs` asks `layers` for what to draw there. Everything here
//! is a pure function of the slot's payload and the clock, so the rules are tested without a GPU.
//!
//! Nothing loops: a one-shot ends after its life, a glow holds one level, and `animating` says
//! whether a slot still changes (false at rest). Every layer is `.reduced()` under reduce-motion,
//! and a CPU renderer draws no layer at all (the matte fallback is the element's own fill).

use rune::{El, effect};
use rune_fx::{
    FlutedGlassParams, Fx, FxLayer, GlowParams, GrainParams, MotionBlurParams, MotionSamples, Pose, PulseParams, PulseStyle, Rect, Shape, SparkleParams, rgb,
};
use rune_motion::Spring;

/// Heat colours from the design: the beam, and its white-hot core.
const BEAM: u32 = 0xF0B44C;
const CORE: u32 = 0xFFD98F;

/// Seconds a stage-done ring lives (design: 0.6 s).
pub const PULSE_LIFE: f32 = 0.6;
/// Hover colour change, 120 ms.
pub const HOVER_SPRING: Spring = Spring::new(0.12, 0.0);

/// The clip rank spring from the Motion notes: stiffness 260, damping 26, mass 1.
pub fn rank_spring() -> Spring {
    Spring::from_stiffness_damping(260.0, 26.0, 1.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moment {
    BeamHead,
    BeamBody,
    StagePulse,
    JobSparkle,
    RankBlur,
    PaletteGlass,
    TransportGlass,
}

impl Moment {
    pub const ALL: [Moment; 7] =
        [Moment::BeamHead, Moment::BeamBody, Moment::StagePulse, Moment::JobSparkle, Moment::RankBlur, Moment::PaletteGlass, Moment::TransportGlass];

    /// The `El::effect` tag of the moment's slot.
    pub fn mark(self) -> u32 {
        0x5300 + Self::ALL.iter().position(|m| *m == self).expect("listed") as u32 + 1
    }

    pub fn from_mark(mark: u32) -> Option<Moment> {
        Self::ALL.into_iter().find(|m| m.mark() == mark)
    }

    /// A slot that reads a copy of the frame drawn so far (glass, and the rank blur's source).
    pub fn needs_backdrop(self) -> bool {
        self.is_glass() || self == Moment::RankBlur
    }

    pub fn is_glass(self) -> bool {
        matches!(self, Moment::PaletteGlass | Moment::TransportGlass)
    }

    /// Light spilling out of a shape (the beam head).
    pub fn is_glow(self) -> bool {
        self == Moment::BeamHead
    }

    pub fn is_one_shot(self) -> bool {
        matches!(self, Moment::StagePulse | Moment::JobSparkle)
    }

    /// Points past its rect a moment may paint.
    fn bleed(self) -> f32 {
        match self {
            Moment::BeamHead => 24.0,
            Moment::StagePulse => 40.0,
            Moment::JobSparkle => 30.0,
            _ => 0.0,
        }
    }
}

/// An effect slot for `moment` with its payload (see `layers` for what each moment reads).
pub fn slot(moment: Moment, data: [f32; 4]) -> El {
    effect(moment.mark()).effect_data(data).effect_bleed(moment.bleed()).effect_backdrop(moment.needs_backdrop())
}

/// How the machine and the person want effects drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Look {
    pub reduced: bool,
    /// Rune draws on a CPU renderer: no layer is drawn.
    pub cpu: bool,
}

/// A slot as the compositor found it: its moment, payload and rect in points.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub moment: Moment,
    pub data: [f32; 4],
    pub rect: Rect,
    pub scale: f32,
}

/// The burst a job's end throws: twelve 4 pt specks, half a second.
pub fn sparkle_params(t0: f32) -> SparkleParams {
    SparkleParams { color: rgb(BEAM), count: 12, life: 0.4, size: 4.0, intensity: 0.9, margin: 12.0, burst: Some(t0) }
}

/// Seconds from the start of the job-done burst until its last speck is gone.
pub fn burst_life() -> f32 {
    sparkle_params(0.0).burst_life()
}

/// The ring a finished stage sends out: one ring, 0.6 s, from the node's edge outward.
pub fn pulse_params(t0: f32) -> PulseParams {
    PulseParams {
        style: PulseStyle::Radar,
        color: rgb(BEAM),
        core: rgb(BEAM),
        count: 1,
        reach: 24.0,
        width: 1.5,
        intensity: 0.6,
        t0,
        duration: PULSE_LIFE,
        repeat: 0.0,
        occlusion: 0.0,
        ..PulseParams::default()
    }
}

/// The head's glow at heat `h` (0 cool, 1 hot): radius 4 to 20 pt, 33% to 80%.
pub fn glow_params(h: f32) -> GlowParams {
    let h = h.clamp(0.0, 1.0);
    GlowParams { color: rgb(BEAM), core: rgb(CORE), radius: 4.0 + 16.0 * h, intensity: 0.33 + 0.47 * h, heat: h, breathe: 0.0, ..GlowParams::default() }
}

/// Reeded glass: the palette frosts at 20, the transport bar at 12; ribs every 8 pt at 5% white.
pub fn glass_params(frost: f32, depth: f32) -> FlutedGlassParams {
    FlutedGlassParams { rib: 8.0, angle: 0.0, refraction: 0.35 * depth, frost: frost / 100.0, dispersion: 0.08, highlight: 0.05, ..FlutedGlassParams::reeded() }
}

/// The share of a rank move still to go `elapsed` seconds after the spring started (1 to 0).
pub fn rank_left(elapsed: f32) -> f32 {
    1.0 - rank_spring().sample(0.0, 0.0, 1.0, elapsed.max(0.0)).0
}

/// What to draw in a slot at time `t`. Empty on a CPU renderer, and empty once a one-shot is over.
///
/// Payloads: `BeamHead` `[heat]`; `StagePulse`, `JobSparkle` `[t0, opacity, seed]`; `RankBlur`
/// `[t0, rows moved in points]`; the rest need none.
pub fn layers(p: Placed, t: f32, look: Look) -> Vec<FxLayer> {
    if look.cpu {
        return vec![];
    }
    let r = p.rect;
    let capsule = Shape::rounded(r.x, r.y, r.w, r.h, r.w.min(r.h) * 0.5);
    match p.moment {
        Moment::BeamHead => {
            // One steady level under reduce-motion, chosen from the last PROGRESS.
            let h = if look.reduced { if p.data[0] > 0.05 { 0.6 } else { 0.0 } } else { p.data[0] };
            vec![Fx::glow(glow_params(h)).on(capsule).at(t).reduced(look.reduced)]
        }
        Moment::BeamBody => vec![Fx::grain(GrainParams { amount: 0.2, fps: 0.0, feather: 0.0 }).on(capsule).over().reduced(look.reduced)],
        Moment::StagePulse if look.reduced || t - p.data[0] >= PULSE_LIFE => vec![],
        Moment::StagePulse => {
            let ring = Shape::circle(r.x + r.w * 0.5, r.y + r.h * 0.5, 8.0);
            vec![Fx::pulse(pulse_params(p.data[0])).on(ring).at(t).seed(p.data[2] as u32).opacity(p.data[1])]
        }
        Moment::JobSparkle if look.reduced || t - p.data[0] >= burst_life() => vec![],
        Moment::JobSparkle => vec![Fx::sparkles(sparkle_params(p.data[0])).on(capsule).at(t).seed(p.data[2] as u32)],
        // The rank blur is drawn per moving row from a copy of the frame (`rank_layers`), not per slot.
        Moment::RankBlur => vec![],
        Moment::PaletteGlass => vec![Fx::fill(glass_params(20.0, 10.0)).on(Shape::rounded(r.x, r.y, r.w, r.h, 12.0)).reduced(look.reduced)],
        Moment::TransportGlass => vec![Fx::fill(glass_params(12.0, 8.0)).on(Shape::rounded(r.x, r.y, r.w, r.h, 12.0)).reduced(look.reduced)],
    }
}

/// The motion blur of rows that just changed rank. Each row is `(its rect now, start, points it
/// still had to travel when the spring began)`; the blur samples the frame copy a `RankBlur` slot
/// hands the compositor (`FxLayer::source` slot 0, covering `viewport`), along the spring's path around where the row is.
pub fn rank_layers(rows: &[(Rect, f32, f32)], viewport: Rect, t: f32, scale: f32, look: Look) -> Vec<FxLayer> {
    if look.cpu || look.reduced {
        return vec![];
    }
    let params = MotionBlurParams::default();
    rows.iter()
        .filter(|(_, t0, dy)| (dy * rank_left(t - t0)).abs() >= 0.5)
        .map(|(rect, t0, dy)| {
            let here = rank_left(t - t0);
            let samples = MotionSamples::from_track(&params, *rect, t, scale, |tt| Pose { y: dy * (rank_left(tt - t0) - here), ..Pose::default() });
            Fx::motion_blur(params, samples).on(Shape::rounded(rect.x, rect.y, rect.w, rect.h, 8.0)).at(t).source(0, viewport)
        })
        .collect()
}

/// Whether a slot still changes at `t`: false for everything at rest (nothing loops).
pub fn animating(p: Placed, t: f32, look: Look) -> bool {
    layers(p, t, look).iter().any(FxLayer::is_animating)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placed(moment: Moment, data: [f32; 4]) -> Placed {
        Placed { moment, data, rect: Rect::new(10.0, 10.0, 24.0, 24.0), scale: 1.0 }
    }

    /// Each moment draws its layer while it lasts and nothing after; normal vs reduced vs CPU.
    #[test]
    fn each_moment_draws_in_its_life_and_nothing_after() {
        // (moment, data, t, layers normal, layers reduced); a CPU renderer draws none.
        for (moment, data, t, normal, reduced) in [
            (Moment::BeamHead, [0.8, 0.0, 0.0, 0.0], 5.0, 1, 1),
            (Moment::BeamBody, [0.0; 4], 5.0, 1, 1),
            (Moment::StagePulse, [1.0, 1.0, 3.0, 0.0], 1.3, 1, 0),
            (Moment::StagePulse, [1.0, 1.0, 3.0, 0.0], 1.7, 0, 0),
            (Moment::JobSparkle, [1.0, 1.0, 3.0, 0.0], 1.2, 1, 0),
            (Moment::JobSparkle, [1.0, 1.0, 3.0, 0.0], 9.0, 0, 0),
            (Moment::PaletteGlass, [0.0; 4], 5.0, 1, 1),
            (Moment::TransportGlass, [0.0; 4], 5.0, 1, 1),
        ] {
            let p = placed(moment, data);
            let got = (layers(p, t, Look::default()).len(), layers(p, t, Look { reduced: true, cpu: false }).len(), layers(p, t, Look { reduced: false, cpu: true }).len());
            assert_eq!(got, (normal, reduced, 0), "{moment:?} at {t}");
        }
    }

    /// At rest nothing animates (the glow holds its level, a finished one-shot is gone, glass is still).
    #[test]
    fn nothing_animates_at_rest() {
        for (moment, data, t) in [
            (Moment::BeamHead, [0.0; 4], 5.0),
            (Moment::BeamBody, [0.0; 4], 5.0),
            (Moment::StagePulse, [1.0, 1.0, 3.0, 0.0], 9.0),
            (Moment::JobSparkle, [1.0, 1.0, 3.0, 0.0], 9.0),
            (Moment::PaletteGlass, [0.0; 4], 5.0),
            (Moment::TransportGlass, [0.0; 4], 5.0),
        ] {
            assert!(!animating(placed(moment, data), t, Look::default()), "{moment:?}");
        }
        assert!(animating(placed(Moment::StagePulse, [1.0, 1.0, 3.0, 0.0]), 1.2, Look::default()));
    }

    /// The glow follows the heat from the design's numbers; a reduced head holds one steady level.
    #[test]
    fn the_head_glow_follows_the_heat() {
        for (h, radius, alpha) in [(0.0, 4.0, 0.33), (0.5, 12.0, 0.565), (1.0, 20.0, 0.8)] {
            let g = glow_params(h);
            assert_eq!((g.radius, (g.intensity * 1000.0).round() / 1000.0, g.breathe), (radius, alpha, 0.0), "heat {h}");
        }
        let level = |heat: f32| match layers(placed(Moment::BeamHead, [heat, 0.0, 0.0, 0.0]), 1.0, Look { reduced: true, cpu: false })[0].fx {
            Fx::Glow(g) => g.radius,
            _ => unreachable!(),
        };
        assert_eq!((level(0.2), level(0.9), level(0.0)), (level(0.9), level(0.2), 4.0));
    }

    /// A row that changed rank is blurred while its spring runs, not when it has settled, reduced or on a CPU renderer.
    #[test]
    fn a_moving_row_is_blurred_and_a_settled_one_is_not() {
        let rows = [(Rect::new(0.0, 100.0, 300.0, 64.0), 1.0, 70.0)];
        let counts: Vec<usize> = [(1.05, Look::default()), (3.0, Look::default()), (1.05, Look { reduced: true, cpu: false }), (1.05, Look { reduced: false, cpu: true })]
            .iter().map(|(t, look)| rank_layers(&rows, Rect::new(0.0, 0.0, 800.0, 600.0), *t, 1.0, *look).len()).collect();
        assert_eq!(counts, [1, 0, 0, 0]);
        assert!(rank_layers(&rows, Rect::new(0.0, 0.0, 800.0, 600.0), 1.05, 1.0, Look::default())[0].source.is_some());
    }

    #[test]
    fn marks_round_trip_and_the_rank_spring_settles() {
        assert!(Moment::ALL.iter().all(|m| Moment::from_mark(m.mark()) == Some(*m)) && Moment::from_mark(7).is_none());
        assert!((rank_left(0.0) - 1.0).abs() < 1e-3 && rank_left(1.5).abs() < 0.01);
        assert!(Moment::ALL.iter().filter(|m| m.is_glass()).count() == 2 && Moment::ALL.iter().filter(|m| m.is_glow()).count() == 1);
        assert!(Moment::ALL.iter().filter(|m| m.is_one_shot()).count() == 2);
    }
}
