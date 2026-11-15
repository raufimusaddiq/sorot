//! Pixel snapshots: every scene in both themes at 1280x800, plus the four main screens at 1920x1080,
//! rendered by the binary headless (`--snap`) and compared with `tests/snapshots/*.png`. A mismatch
//! writes `<name>.diff.png` beside the approved image (differing pixels in red). The approved
//! images come from the look-and-fix review (`design/look-and-fix.md`); `SOROT_APPROVE=1` rewrites
//! them after that review, never otherwise.

mod support;

use std::path::{Path, PathBuf};

/// A channel may differ by this much (anti-aliasing, GPU rounding) before a pixel counts as changed.
const TOLERANCE: i16 = 12;
/// Changed pixels allowed, in parts per ten thousand of the image.
const ALLOWED: usize = 10;

fn decode(path: &Path) -> (u32, u32, Vec<u8>) {
    let mut reader = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap())).read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()].chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        other => panic!("{other:?} snapshots are not handled"),
    };
    (info.width, info.height, rgba)
}

fn write(path: &Path, w: u32, h: u32, rgba: &[u8]) {
    let mut enc = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(path).unwrap()), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(rgba).unwrap();
}

/// The number of changed pixels, with a diff image written when there are too many.
fn compare(name: &str, got: &Path, approved: &Path) -> Result<(), String> {
    let (gw, gh, g) = decode(got);
    if std::env::var("SOROT_APPROVE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(approved.parent().unwrap()).unwrap();
        write(approved, gw, gh, &g);
        return Ok(());
    }
    if !approved.is_file() {
        return Err(format!("{name}: no approved image at {} (the look-and-fix review makes them)", approved.display()));
    }
    let (aw, ah, a) = decode(approved);
    if (gw, gh) != (aw, ah) {
        return Err(format!("{name}: size {gw}x{gh}, approved {aw}x{ah}"));
    }
    let mut diff = a.clone();
    let mut changed = 0;
    for (i, (p, q)) in g.chunks(4).zip(a.chunks(4)).enumerate() {
        if p.iter().zip(q).any(|(x, y)| (i16::from(*x) - i16::from(*y)).abs() > TOLERANCE) {
            changed += 1;
            diff[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 0, 255]);
        }
    }
    if changed * 10_000 > ALLOWED * (gw * gh) as usize {
        write(&approved.with_extension("diff.png"), gw, gh, &diff);
        return Err(format!("{name}: {changed} pixels changed; diff at {}", approved.with_extension("diff.png").display()));
    }
    Ok(())
}

fn rows() -> Vec<(String, &'static str, &'static str)> {
    let scenes = sorot_desktop::app::SCENES.iter().map(|(n, _)| *n);
    let mut out: Vec<_> = scenes.flat_map(|s| ["dark", "light"].map(move |t| (s.to_string(), t, "1280x800"))).collect();
    for s in ["home-empty", "job-running", "clips-ranked", "editor-hook"] {
        out.extend(["dark", "light"].map(|t| (s.to_string(), t, "1920x1080")));
    }
    out
}

#[test]
fn every_scene_matches_its_approved_image() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots");
    let failures: Vec<String> = rows()
        .into_iter()
        .filter_map(|(scene, theme, size)| {
            let name = format!("{scene}-{theme}-{size}");
            let got = support::headless::snap(&scene, theme, size);
            let result = compare(&name, &got, &dir.join(format!("{name}.png")));
            let _ = std::fs::remove_file(got);
            result.err()
        })
        .collect();
    assert_eq!(failures, Vec::<String>::new());
}

/// The comparison itself: equal images pass, a few changed pixels pass, a changed region fails and writes a diff.
#[test]
fn the_comparison_tolerates_noise_and_catches_a_changed_region() {
    let dir = support::headless::temp_dir();
    let (w, h) = (100u32, 100u32);
    let base = vec![40u8; (w * h * 4) as usize];
    write(&dir.join("approved.png"), w, h, &base);
    let mut noisy = base.clone();
    noisy[..4].copy_from_slice(&[200, 200, 200, 255]);
    let mut moved = base.clone();
    moved.chunks_mut(4).take(500).for_each(|p| p[0] = 255);
    for (label, img, ok) in [("same", &base, true), ("noise", &noisy, true), ("region", &moved, false)] {
        write(&dir.join("got.png"), w, h, img);
        assert_eq!(compare(label, &dir.join("got.png"), &dir.join("approved.png")).is_ok(), ok, "{label}");
    }
    assert!(dir.join("approved.diff.png").is_file());
    let _ = std::fs::remove_dir_all(dir);
}
