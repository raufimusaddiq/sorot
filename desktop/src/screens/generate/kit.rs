//! The kit: the drawing and motion parts directors build scenes from (`KitPanel.tsx`), as cards.
//! Built-in parts come with Sorot; your own are added on the engine's side (checked there: the
//! example renders twice the same) and can be removed. Each part can be exported to the Downloads
//! folder.

use std::path::PathBuf;

use rune::tok::type_;
use rune::{El, FileDialogOptions, Tx, col, row, text};

use crate::engine::generate as api;
use crate::engine::generate::KitPart;
use crate::screens::generate::Studio;
use crate::screens::generate::{t, tf};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{Tone, btn, btn_tx, card, heading, note};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

#[derive(Default)]
pub struct Kit {
    pub load: Load,
    pub parts: Vec<KitPart>,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
    /// Where exports go; `None` is the Downloads folder.
    pub save_dir: Option<PathBuf>,
}

fn listed(p: &mut Panels, r: Result<Vec<KitPart>, String>) {
    let k = &mut p.studio.kit;
    (k.busy, k.load) = (false, Load::of(&r));
    match r {
        Ok(parts) => k.parts = parts,
        Err(why) => k.error = Some(why),
    }
}

/// Reads the parts when the page opens.
pub fn load<H: Host>(h: &mut H) {
    h.panels_mut().studio.kit.load = Load::Loading;
    go(h, |e| answer(api::kit_parts(e), listed));
}

/// Sends a part's .zip to the engine, which checks it before it is kept.
pub fn add<H: Host>(h: &mut H, zip: PathBuf) {
    let k = &mut h.panels_mut().studio.kit;
    (k.busy, k.error, k.notice) = (true, None, None);
    go(h, move |e| {
        answer(api::add_kit_part(e, &zip).and_then(|part| Ok((part, api::kit_parts(e)?))), |p, r| match r {
            Ok((part, parts)) => {
                p.studio.kit.notice = Some(tf("kit.added", &[&part.name, &part.version]));
                listed(p, Ok(parts));
            }
            Err(why) => (p.studio.kit.busy, p.studio.kit.error) = (false, Some(why)),
        })
    });
}

/// The dialog for the .zip of a part.
fn ask<H: Host>(_: &mut H, tx: &mut Tx) {
    let options = FileDialogOptions { title: t("kit.add"), ..Default::default() }.filter("Kit", &["zip"]);
    tx.open_file(options, |h: &mut H, r, _| match r {
        Ok(Some(path)) => add(h, path),
        Ok(None) => {}
        Err(e) => h.panels_mut().studio.kit.error = Some(e.to_string()),
    });
}

pub fn remove<H: Host>(h: &mut H, name: &str) {
    let name = name.to_string();
    let k = &mut h.panels_mut().studio.kit;
    (k.busy, k.error, k.notice) = (true, None, None);
    go(h, move |e| {
        answer(api::remove_kit_part(e, &name).and_then(|()| api::kit_parts(e)), |p, r| {
            if r.is_ok() {
                p.studio.kit.notice = Some(t("kit.removed"));
            }
            listed(p, r);
        })
    });
}

/// Where an exported part goes: `home`/Downloads when that folder exists, else the temp folder.
fn downloads_in(home: Option<PathBuf>) -> PathBuf {
    home.map(|h| h.join("Downloads")).filter(|d| d.is_dir()).unwrap_or_else(std::env::temp_dir)
}

fn downloads() -> PathBuf {
    downloads_in(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from))
}

/// Saves the part's .zip from the engine.
pub fn export<H: Host>(h: &mut H, name: &str) {
    let name = name.to_string();
    let k = &mut h.panels_mut().studio.kit;
    (k.error, k.notice) = (None, None);
    let dir = k.save_dir.clone().unwrap_or_else(downloads);
    go(h, move |e| {
        let dest = dir.join(format!("{name}.zip"));
        let r = e.download(&format!("/api/generate/kit/{}/export", crate::engine::http::encode(&name)), &dest).map(|_| dest);
        answer(r, |p, r| match r {
            Ok(dest) => p.studio.kit.notice = Some(tf("kit.saved", &[&dest.display().to_string()])),
            Err(why) => p.studio.kit.error = Some(why),
        })
    });
}

pub fn view<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let k = &s.kit;
    let head = heading(dark, "generate/kit/title", &t("kit.title"), &t("kit.sub"));
    let mut c = col().gap(16.0).w_full().child(head).child(btn_tx(dark, "generate/kit/add", &t("kit.add"), !k.busy, ask::<H>));
    if k.load == Load::Ready && k.parts.is_empty() {
        return c.child(state_block::<H>(dark, "generate/kit/empty", Kind::Empty, &t("kit.empty.cause"), &t("kit.empty.next"), None));
    }
    let mut grid = row().gap(16.0).w_full();
    for part in &k.parts {
        let key = |n: &str| format!("generate/kit/{}/{n}", part.name);
        let own = part.source == "user";
        let (a, b) = (part.name.clone(), part.name.clone());
        let mut actions = row().gap(8.0).child(btn(dark, key("export"), &t("kit.export"), false, !k.busy, move |h: &mut H| export(h, &a)));
        if own {
            actions = actions.child(btn(dark, key("remove"), &tf("kit.remove", &[&part.name]), false, !k.busy, move |h: &mut H| remove(h, &b)));
        }
        grid = grid.child(
            col().grow(1.0).child(
                card(dark, &key("card"), &part.name)
                    .child(text(format!("{} · {} · {}", t(if own { "kit.own" } else { "kit.builtin" }), part.version, part.manifest.runtime)).font(type_::LABEL).color(p.muted))
                    .child(text(part.manifest.does.as_str()).font(type_::BODY).color(p.muted).wrap())
                    .child(actions),
            ),
        );
    }
    c = c.child(grid);
    if let Some(why) = &k.error {
        c = c.child(note(dark, "generate/kit/error", Tone::Bad, why));
    }
    if let Some(done) = &k.notice {
        c = c.child(note(dark, "generate/kit/notice", Tone::Ok, done));
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exports go to Downloads when there is one, and to the temp folder when not.
    #[test]
    fn exports_go_to_downloads_or_the_temp_folder() {
        let home = std::env::temp_dir().join(format!("sorot-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        assert_eq!(downloads_in(Some(home.clone())), home.join("Downloads"));
        assert_eq!((downloads_in(None), downloads_in(Some(home.join("nowhere")))), (std::env::temp_dir(), std::env::temp_dir()));
        assert!(downloads().is_absolute());
        let _ = std::fs::remove_dir_all(home);
    }
}
