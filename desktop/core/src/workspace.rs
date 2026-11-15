//! `workspace.json` (where the engine's data lives) and the ranking of existing libraries.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    New,
    Adopted,
    Copied,
}

/// Only `local` for now; a remote engine would add a variant here, and its token would not live in this file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub data_dir: String,
    pub source: Source,
    #[serde(default)]
    pub adopted_from: Option<String>,
    pub engine: EngineKind,
}

/// One library the engine's `--find-libraries` found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub ok: bool,
    pub videos: u32,
    pub clips: u32,
    pub has_keys: bool,
    #[serde(default)]
    pub problem: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Found {
    candidates: Vec<Candidate>,
}

impl Candidate {
    /// The `data` of a `--find-libraries` answer.
    pub fn parse_found(json: &str) -> serde_json::Result<Vec<Candidate>> {
        serde_json::from_str::<Found>(json).map(|f| f.candidates)
    }
}

/// Healthy libraries first, the most clips first among them; a library with a problem is never first
/// while a healthy one exists. Equal ones keep the engine's order.
pub fn rank_candidates(list: &[Candidate]) -> Vec<Candidate> {
    let mut out = list.to_vec();
    out.sort_by_key(|c| (!c.ok || c.problem.is_some(), std::cmp::Reverse(c.clips)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(path: &str, ok: bool, clips: u32, problem: Option<&str>) -> Candidate {
        Candidate { path: path.into(), ok, videos: 1, clips, has_keys: false, problem: problem.map(Into::into) }
    }

    #[test]
    fn candidates_rank_healthy_then_clips() {
        let table = [
            (vec![cand("a", true, 3, None), cand("b", true, 9, None)], "ba"),
            (vec![cand("a", false, 50, Some("locked")), cand("b", true, 1, None)], "ba"),
            (vec![cand("a", true, 5, Some("odd")), cand("b", true, 1, None)], "ba"),
            (vec![cand("a", true, 4, None), cand("b", true, 4, None)], "ab"),
            (vec![], ""),
        ];
        for (list, want) in table {
            let got: String = rank_candidates(&list).iter().map(|c| c.path.as_str()).collect();
            assert_eq!(got, want);
        }
    }

    #[test]
    fn workspace_file_round_trips_without_a_token() {
        let w = Workspace { data_dir: "/d".into(), source: Source::Adopted, adopted_from: Some("/old".into()), engine: EngineKind::Local };
        let json = serde_json::to_string(&w).unwrap();
        assert_eq!(json, r#"{"dataDir":"/d","source":"adopted","adoptedFrom":"/old","engine":"local"}"#);
        assert_eq!(serde_json::from_str::<Workspace>(&json).unwrap(), w);
        assert!(serde_json::from_str::<Workspace>(r#"{"dataDir":"/d","source":"new","engine":"local","token":"x"}"#).is_err());
        let found = Candidate::parse_found(r#"{"candidates":[{"path":"/p","ok":true,"videos":2,"clips":7,"hasKeys":true}]}"#).unwrap();
        assert_eq!((found[0].clips, found[0].has_keys), (7, true));
    }
}
