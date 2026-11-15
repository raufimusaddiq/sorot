//! The publish button's gate. Every choice the user owns starts empty and is never pre-filled;
//! `can_post` is true only when each target's required choices are set.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Tiktok,
    Youtube,
    Other,
}

/// One account in the draft. `video_public_only`: the account can only post publicly, so TikTok
/// needs no privacy choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub platform: Platform,
    pub video_public_only: bool,
}

/// What the user has chosen for one target. `Default` is everything unset.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Choices {
    pub tiktok_privacy: Option<String>,
    pub tiktok_draft_mode: bool,
    pub youtube_title: String,
    pub made_for_kids: Option<bool>,
}

fn ready(t: &Target, c: &Choices) -> bool {
    match t.platform {
        Platform::Tiktok => t.video_public_only || c.tiktok_draft_mode || c.tiktok_privacy.is_some(),
        Platform::Youtube => !c.youtube_title.trim().is_empty() && c.made_for_kids.is_some(),
        Platform::Other => true,
    }
}

/// One `Choices` per target, in order. An empty draft, or a missing entry, is not postable.
pub fn can_post(draft: &[Target], choices: &[Choices]) -> bool {
    !draft.is_empty() && draft.len() == choices.len() && draft.iter().zip(choices).all(|(t, c)| ready(t, c))
}

/// One account as the list shows it: its id, whether it can take a video, and its Tebar workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Listed<'a> {
    pub id: &'a str,
    pub supported: bool,
    pub workspace: &'a str,
}

/// The accounts picked last time that are still listed and can post, kept to one workspace (a post
/// goes to one): the workspace of the first of them in the list.
pub fn preselect(saved: &[String], listed: &[Listed]) -> Vec<String> {
    let ok: Vec<&Listed> = listed.iter().filter(|a| a.supported && saved.iter().any(|s| s == a.id)).collect();
    let Some(first) = ok.first() else { return vec![] };
    ok.iter().filter(|a| a.workspace == first.workspace).map(|a| a.id.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_times_accounts_come_back_only_if_listed_postable_and_in_one_workspace() {
        let a = |id, supported, workspace| Listed { id, supported, workspace };
        let list = [a("tt", true, "w1"), a("ig", true, "w2"), a("yt", true, "w1"), a("th", false, "w1")];
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for (saved, want) in [
            (ids(&["tt", "yt"]), ids(&["tt", "yt"])),
            (ids(&["ig", "tt"]), ids(&["tt"])),
            (ids(&["th", "gone"]), ids(&[])),
            (ids(&[]), ids(&[])),
        ] {
            assert_eq!(preselect(&saved, &list), want, "{saved:?}");
        }
    }

    #[test]
    fn exemption_and_draft_mode_stand_in_for_privacy() {
        let tiktok = |public_only| Target { platform: Platform::Tiktok, video_public_only: public_only };
        let draft_mode = Choices { tiktok_draft_mode: true, ..Choices::default() };
        let youtube = Target { platform: Platform::Youtube, video_public_only: false };
        let yt = Choices { youtube_title: " Judul ".into(), made_for_kids: Some(false), ..Choices::default() };
        assert!(can_post(&[tiktok(true)], &[Choices::default()]), "public-only account");
        assert!(can_post(&[tiktok(false)], &[draft_mode]), "draft mode");
        assert!(can_post(&[tiktok(false), youtube], &[Choices { tiktok_privacy: Some("SELF_ONLY".into()), ..Choices::default() }, yt.clone()]));
        assert!(!can_post(&[], &[]), "nothing to post");
        assert!(!can_post(&[tiktok(true), youtube], &[Choices::default()]), "a target without choices");
        assert!(!can_post(&[youtube], &[Choices { youtube_title: "  ".into(), ..yt }]), "blank title");
        assert!(can_post(&[Target { platform: Platform::Other, video_public_only: false }], &[Choices::default()]));
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(4)]
    fn an_unset_required_choice_blocks_posting() {
        let platform = match kani::any::<u8>() % 3 {
            0 => Platform::Tiktok,
            1 => Platform::Youtube,
            _ => Platform::Other,
        };
        let t = Target { platform, video_public_only: kani::any() };
        let c = Choices {
            tiktok_privacy: kani::any::<bool>().then(|| "x".to_string()),
            tiktok_draft_mode: kani::any(),
            youtube_title: if kani::any() { "t".to_string() } else { String::new() },
            made_for_kids: kani::any::<bool>().then(|| kani::any()),
        };
        let tiktok_unset = platform == Platform::Tiktok && !t.video_public_only && !c.tiktok_draft_mode && c.tiktok_privacy.is_none();
        let youtube_unset = platform == Platform::Youtube && (c.youtube_title.is_empty() || c.made_for_kids.is_none());
        if tiktok_unset || youtube_unset {
            assert!(!can_post(&[t], &[c]));
        }
    }

    #[kani::proof]
    fn fresh_choices_post_only_where_nothing_is_owned() {
        let platform = match kani::any::<u8>() % 3 {
            0 => Platform::Tiktok,
            1 => Platform::Youtube,
            _ => Platform::Other,
        };
        let t = Target { platform, video_public_only: kani::any() };
        if can_post(&[t], &[Choices::default()]) {
            assert!(platform == Platform::Other || (platform == Platform::Tiktok && t.video_public_only));
        }
    }
}
