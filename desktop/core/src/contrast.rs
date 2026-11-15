//! WCAG 2.1 contrast of the generated theme (`desktop/theme/sorot.json`).

use serde_json::Value;

/// Relative luminance of `#rrggbb` (alpha, if any, is ignored). `None` for anything else.
fn luminance(hex: &str) -> Option<f64> {
    let h = hex.strip_prefix('#').filter(|h| matches!(h.len(), 6 | 8) && h.is_ascii())?;
    let channel = |i: usize| {
        let v = f64::from(u8::from_str_radix(&h[i..i + 2], 16).ok()?) / 255.0;
        Some(if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) })
    };
    Some(0.2126 * channel(0)? + 0.7152 * channel(2)? + 0.0722 * channel(4)?)
}

/// Contrast ratio, 1..=21. A colour that does not parse gives 0.0, which fails every minimum.
pub fn ratio(fg: &str, bg: &str) -> f64 {
    let (Some(a), Some(b)) = (luminance(fg), luminance(bg)) else { return 0.0 };
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub mode: &'static str,
    pub fg: String,
    pub bg: String,
    pub ratio: f64,
    pub min: f64,
}

/// Text on every surface (4.5), the dark label on the beam fill (4.5), control boundaries and the
/// focus ring (3), and text over video, which stays dark in both modes (4.5). A `#` name is a literal.
fn pairs() -> Vec<(&'static str, &'static str, f64)> {
    let mut p = Vec::new();
    for fg in ["text", "muted", "beamText", "steel", "pass", "skip", "review"] {
        for bg in ["bg", "surface", "raised"] {
            p.push((fg, bg, 4.5));
        }
    }
    p.extend([
        ("#17191c", "beam", 4.5), ("edge", "raised", 3.0), ("edge", "surface", 3.0), ("beamText", "bg", 3.0),
        ("#ece8e1", "#0e0f11", 4.5), ("#a39e95", "#0e0f11", 4.5), ("#e07a68", "#0e0f11", 4.5),
    ]);
    p
}

pub fn check_theme(theme: &Value) -> Vec<Failure> {
    let mut out = Vec::new();
    for mode in ["dark", "light"] {
        let colour = |n: &'static str| -> &str { if n.starts_with('#') { n } else { theme[mode][n].as_str().unwrap_or("") } };
        for (fg, bg, min) in pairs() {
            let r = ratio(colour(fg), colour(bg));
            if r < min {
                out.push(Failure { mode, fg: fg.into(), bg: bg.into(), ratio: r, min });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const THEME: &str = include_str!("../../theme/sorot.json");

    #[test]
    fn ratios_match_the_measured_design_table() {
        let theme: Value = serde_json::from_str(THEME).unwrap();
        // (fg, bg, dark, light) from desktop/design/README.md
        for (fg, bg, dark, light) in [
            ("text", "bg", 15.70, 15.61), ("muted", "raised", 6.07, 7.08), ("beamText", "bg", 10.35, 5.46),
            ("pass", "bg", 8.69, 4.64), ("skip", "raised", 5.50, 5.69), ("edge", "raised", 4.11, 4.02), ("edge", "surface", 4.52, 3.82),
        ] {
            for (mode, want) in [("dark", dark), ("light", light)] {
                let got = ratio(theme[mode][fg].as_str().unwrap(), theme[mode][bg].as_str().unwrap());
                assert!((got - want).abs() < 0.006, "{fg} on {bg} {mode}: {got:.3} vs {want}");
            }
        }
        assert!((ratio("#000000", "#ffffff") - 21.0).abs() < 1e-9);
        assert!((ratio("#ffffffff", "#000000") - 21.0).abs() < 1e-9, "alpha is ignored");
        for bad in ["", "#fff", "red", "#gggggg", "#12é456"] {
            assert_eq!(ratio(bad, "#ffffff"), 0.0, "{bad}");
        }
    }

    #[test]
    fn the_shipped_theme_passes_and_a_weak_one_is_named() {
        let mut theme: Value = serde_json::from_str(THEME).unwrap();
        assert_eq!(check_theme(&theme), vec![]);
        theme["light"]["muted"] = "#e0dcd0".into();
        theme["dark"]["edge"] = Value::Null;
        let fails = check_theme(&theme);
        assert!(fails.iter().any(|f| f.mode == "light" && f.fg == "muted" && f.bg == "bg" && f.min == 4.5 && f.ratio < 2.0));
        assert!(fails.iter().any(|f| f.mode == "dark" && f.fg == "edge" && f.ratio == 0.0 && f.min == 3.0));
    }
}
