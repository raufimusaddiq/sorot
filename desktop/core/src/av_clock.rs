//! Linux preview pacing: which decoded frame to show for the audio clock, and where a seek restarts.

/// The latest frame whose `pts` is at or before the audio clock; `frames_pts` is sorted ascending.
pub fn pick_frame(frames_pts: &[i64], audio_clock: i64) -> Option<usize> {
    let mut best = None;
    for (i, pts) in frames_pts.iter().enumerate() {
        if *pts > audio_clock {
            break;
        }
        best = Some(i);
    }
    best
}

/// The `-ss` argument (seconds) that restarts the two ffmpeg processes at `t_ms`; never negative.
pub fn seek_restart(t_ms: i64) -> String {
    let t = t_ms.max(0);
    format!("{}.{:03}", t / 1000, t % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_and_seek_table() {
        for (pts, clock, want) in [
            (&[][..], 10, None),
            (&[5, 10, 15][..], 4, None),
            (&[5, 10, 15][..], 10, Some(1)),
            (&[5, 10, 15][..], 99, Some(2)),
            (&[5, 5, 9][..], 5, Some(1)),
        ] {
            assert_eq!(pick_frame(pts, clock), want, "{pts:?} @ {clock}");
        }
        for (t, want) in [(0, "0.000"), (12_345, "12.345"), (-50, "0.000"), (60_007, "60.007")] {
            assert_eq!(seek_restart(t), want);
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(8)]
    fn the_picked_frame_is_the_latest_not_after_the_clock() {
        let all: [i64; 6] = [kani::any(), kani::any(), kani::any(), kani::any(), kani::any(), kani::any()];
        let n: usize = kani::any();
        kani::assume(n <= 6);
        let pts = &all[..n];
        for w in pts.windows(2) {
            kani::assume(w[0] <= w[1]);
        }
        let clock: i64 = kani::any();
        match pick_frame(pts, clock) {
            Some(i) => {
                assert!(pts[i] <= clock);
                assert!(pts[i + 1..].iter().all(|p| *p > clock));
            }
            None => assert!(pts.iter().all(|p| *p > clock)),
        }
    }
}
