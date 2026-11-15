//! Design tokens (W3C DTCG, `desktop/design/tokens.json`) → Rune `Theme::from_json` document.
//! `desktop/build.rs` writes the result to `desktop/theme/sorot.json`; that file is generated, never edited.

use serde_json::{Map, Value, json};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ThemeError {
    #[error("tokens: not valid JSON: {0}")]
    Json(String),
    #[error("tokens: missing {0}")]
    Missing(String),
    #[error("tokens: {0}: unsupported type {1:?}")]
    Type(String, String),
    #[error("tokens: {0}: bad value {1:?}")]
    Value(String, String),
}

fn group<'a>(root: &'a Value, path: &[&str]) -> Result<&'a Map<String, Value>, ThemeError> {
    path.iter()
        .try_fold(root, |v, k| v.get(*k))
        .and_then(Value::as_object)
        .ok_or_else(|| ThemeError::Missing(path.join(".")))
}

/// `(type, value)` of a token, checking the type is the one the group expects.
fn token<'a>(at: &str, t: &'a Value, want: &str) -> Result<&'a str, ThemeError> {
    let ty = t.get("$type").and_then(Value::as_str).unwrap_or("");
    if ty != want {
        return Err(ThemeError::Type(at.into(), ty.into()));
    }
    t.get("$value").and_then(Value::as_str).ok_or_else(|| ThemeError::Value(at.into(), String::new()))
}

fn colors(root: &Value, mode: &str) -> Result<Value, ThemeError> {
    let mut out = Map::new();
    for (k, t) in group(root, &["color", mode])? {
        let at = format!("color.{mode}.{k}");
        let v = token(&at, t, "color")?;
        let hex = v.strip_prefix('#').filter(|h| matches!(h.len(), 6 | 8) && h.bytes().all(|b| b.is_ascii_hexdigit()));
        if hex.is_none() {
            return Err(ThemeError::Value(at, v.into()));
        }
        out.insert(k.clone(), json!(v.to_ascii_lowercase()));
    }
    Ok(Value::Object(out))
}

fn dimensions(root: &Value, kind: &str, numbers: &mut Map<String, Value>) -> Result<(), ThemeError> {
    for (k, t) in group(root, &[kind])? {
        let at = format!("{kind}.{k}");
        let v = token(&at, t, "dimension")?;
        let n: f64 = v.strip_suffix("px").and_then(|n| n.parse().ok()).ok_or_else(|| ThemeError::Value(at, v.into()))?;
        numbers.insert(format!("{kind}-{k}"), json!(n));
    }
    Ok(())
}

pub fn tokens_to_theme(tokens_json: &str) -> Result<String, ThemeError> {
    let root: Value = serde_json::from_str(tokens_json).map_err(|e| ThemeError::Json(e.to_string()))?;
    let mut numbers = Map::new();
    dimensions(&root, "space", &mut numbers)?;
    dimensions(&root, "radius", &mut numbers)?;
    let family = token("font.family", group(&root, &["font"])?.get("family").unwrap_or(&Value::Null), "fontFamily")?;
    let theme = json!({
        "name": "Sorot",
        "font": family,
        "blend": { "mode": "srgb", "over": "bg" },
        "dark": colors(&root, "dark")?,
        "light": colors(&root, "light")?,
        "numbers": numbers,
    });
    Ok(serde_json::to_string_pretty(&theme).expect("a Value serializes") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKENS: &str = include_str!("../../design/tokens.json");
    const COMMITTED: &str = include_str!("../../theme/sorot.json");

    fn mini(extra: &str) -> String {
        format!(
            r##"{{"color":{{"dark":{{"bg":{{"$type":"color","$value":"#0E0F11"}}}},"light":{{"bg":{{"$type":"color","$value":"#F4F1EA"}}}}}},
"space":{{"4":{{"$type":"dimension","$value":"4px"}}}},"radius":{{"2":{{"$type":"dimension","$value":"2.5px"}}}},
"font":{{"family":{{"$type":"fontFamily","$value":"Instrument Sans"}}}}{extra}}}"##
        )
    }

    #[test]
    fn each_token_kind_lands_in_its_place() {
        let t: Value = serde_json::from_str(&tokens_to_theme(&mini("")).unwrap()).unwrap();
        assert_eq!(t["dark"]["bg"], "#0e0f11");
        assert_eq!(t["light"]["bg"], "#f4f1ea");
        assert_eq!(t["numbers"]["space-4"], 4.0);
        assert_eq!(t["numbers"]["radius-2"], 2.5);
        assert_eq!(t["font"], "Instrument Sans");
        assert_eq!(t["blend"]["over"], "bg");
    }

    #[test]
    fn broken_tokens_are_errors() {
        let no = |from: &str, to: &str| tokens_to_theme(&mini("").replace(from, to)).unwrap_err();
        assert_eq!(no(r#""light""#, r#""other""#), ThemeError::Missing("color.light".into()));
        assert_eq!(no(r#""dark""#, r#""other""#), ThemeError::Missing("color.dark".into()));
        assert_eq!(no(r#""space""#, r#""gap""#), ThemeError::Missing("space".into()));
        assert_eq!(no(r#""font""#, r#""fonts""#), ThemeError::Missing("font".into()));
        assert!(matches!(no("#0E0F11", "red"), ThemeError::Value(..)));
        assert!(matches!(no("4px", "4em"), ThemeError::Value(..)));
        assert!(matches!(no(r##""$type":"color","$value":"#F4"##, r##""$type":"string","$value":"#F4"##), ThemeError::Type(..)));
        assert!(matches!(no(r#""$value":"Instrument Sans""#, r#""$value":7"#), ThemeError::Value(..)));
        assert!(matches!(tokens_to_theme("{").unwrap_err(), ThemeError::Json(_)));
    }

    #[test]
    fn real_tokens_load_in_both_modes_and_the_committed_theme_is_fresh() {
        let fresh = tokens_to_theme(TOKENS).unwrap();
        assert_eq!(fresh, COMMITTED, "desktop/theme/sorot.json is stale: run `cargo build` in desktop/");
        let v: Value = serde_json::from_str(&fresh).unwrap();
        assert_eq!(v["dark"].as_object().unwrap().len(), v["light"].as_object().unwrap().len());
    }
}
