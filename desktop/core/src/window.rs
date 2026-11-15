//! Where the main window opens: where it was, unless that spot is gone.

pub const MIN_W: u32 = 960;
pub const MIN_H: u32 = 640;
pub const DEFAULT_W: u32 = 1280;
pub const DEFAULT_H: u32 = 800;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// The saved window is just its rectangle.
pub type WindowState = Rect;

impl Rect {
    /// Shares some area (touching edges do not count).
    pub fn intersects(&self, o: &Rect) -> bool {
        let (ax, ay, ox, oy) = (i64::from(self.x), i64::from(self.y), i64::from(o.x), i64::from(o.y));
        ax < ox + i64::from(o.w) && ox < ax + i64::from(self.w) && ay < oy + i64::from(o.h) && oy < ay + i64::from(self.h)
    }
}

/// The saved rectangle if it still touches a monitor, else the default size centred on the primary
/// monitor (the first). Either way no smaller than 960x640. Monitor rectangles are in the same
/// pixels as the saved one; with none known the window opens at the origin.
pub fn restore(saved: WindowState, monitors: &[Rect]) -> Rect {
    if monitors.iter().any(|m| saved.intersects(m)) {
        return Rect { w: saved.w.max(MIN_W), h: saved.h.max(MIN_H), ..saved };
    }
    let Some(primary) = monitors.first() else { return Rect { x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H } };
    let centre = |at: i32, room: u32, size: u32| (i64::from(at) + (i64::from(room) - i64::from(size)) / 2) as i32;
    Rect { x: centre(primary.x, primary.w, DEFAULT_W), y: centre(primary.y, primary.h, DEFAULT_H), w: DEFAULT_W, h: DEFAULT_H }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_table() {
        let r = |x, y, w, h| Rect { x, y, w, h };
        let (a, b) = (r(0, 0, 1920, 1080), r(1920, 0, 2560, 1440));
        for (name, saved, monitors, want) in [
            ("same monitor", r(100, 80, 1100, 700), vec![a], r(100, 80, 1100, 700)),
            ("second monitor still there", r(2000, 50, 1300, 800), vec![a, b], r(2000, 50, 1300, 800)),
            ("second monitor unplugged", r(2000, 50, 1300, 800), vec![a], r(320, 140, 1280, 800)),
            ("primary moved to the right", r(0, 0, 1300, 800), vec![r(-1920, 0, 1920, 1080), b], r(-1600, 140, 1280, 800)),
            ("mixed scaling: partly on a monitor", r(1800, 900, 1300, 800), vec![a, r(1920, 0, 1280, 720)], r(1800, 900, 1300, 800)),
            ("saved too small", r(10, 10, 300, 200), vec![a], r(10, 10, 960, 640)),
            ("only touches an edge", r(1920, 0, 1000, 700), vec![a], r(320, 140, 1280, 800)),
            ("small primary", r(5000, 0, 1000, 700), vec![r(0, 0, 800, 600)], r(-240, -100, 1280, 800)),
            ("no monitor known", r(5, 5, 1000, 700), vec![], r(0, 0, 1280, 800)),
        ] {
            assert_eq!(restore(saved, &monitors), want, "{name}");
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_rect(coord: i32, size: u32) -> Rect {
        let r = Rect { x: kani::any(), y: kani::any(), w: kani::any(), h: kani::any() };
        kani::assume((-coord..=coord).contains(&r.x) && (-coord..=coord).contains(&r.y) && r.w <= size && r.h <= size);
        r
    }

    #[kani::proof]
    #[kani::unwind(5)]
    fn the_restored_window_touches_a_monitor_and_is_big_enough() {
        let mut monitors = [Rect { x: 0, y: 0, w: 1, h: 1 }; 3];
        for m in &mut monitors {
            *m = any_rect(100_000, 10_000);
            kani::assume(m.w > 0 && m.h > 0);
        }
        let n: usize = kani::any();
        kani::assume((1..=3).contains(&n));
        let out = restore(any_rect(200_000, 20_000), &monitors[..n]);
        assert!(monitors[..n].iter().any(|m| out.intersects(m)));
        assert!(out.w >= MIN_W && out.h >= MIN_H);
    }
}
