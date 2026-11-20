//! What surrounds every screen: the left rail, the connection banner and the close dialog.

use rune::tok::type_;
use rune::{El, col, row, text};

use crate::app::{Conn, Screen, State};
use crate::i18n::{tr, trf};
use crate::screens::panels::{Host, Page};
use crate::ui::kit::{button, pal};

/// Shown while the engine is lost or failed; `None` when the connection is fine.
pub fn banner(s: &State) -> Option<El> {
    let p = pal(s.dark());
    let l = s.lang;
    let words = match &s.conn {
        Conn::Lost => tr(l, "shell.banner.lost"),
        Conn::Failed(_) => tr(l, "shell.banner.failed"),
        Conn::Starting | Conn::Ready => return None,
    };
    Some(
        row().key("shell/banner").role("alert").label(words.clone()).gap(12.0).padding(12.0).items_center().w_full().fill(p.raised).border(1.0, p.skip)
            .child(text(words).key("shell/banner/text").font(type_::BODY).color(p.text).wrap().grow(1.0))
            .child(button(s.dark(), "engine/restart", &tr(l, "shell.restart-engine"), true, |s: &mut State| s.restart_engine()))
            .child(button(s.dark(), "shell/export-diagnostic", &tr(l, "shell.export-diagnostic"), false, |s: &mut State| s.export_diagnostic())),
    )
}

/// The one notice on a machine whose graphics run on the CPU; dismissing it keeps effects off.
pub fn gpu_notice(s: &State) -> Option<El> {
    if !s.gpu_notice {
        return None;
    }
    let p = pal(s.dark());
    let words = tr(s.lang, "gpu.notice");
    Some(
        row().key("shell/gpu-notice").role("status").label(words.clone()).gap(12.0).padding(12.0).items_center().w_full().fill(p.raised).border(1.0, p.divider)
            .child(text(words).key("shell/gpu-notice/text").font(type_::BODY).color(p.text).wrap().grow(1.0))
            .child(button(s.dark(), "shell/gpu-notice/dismiss", &tr(s.lang, "gpu.dismiss"), false, |s: &mut State| s.dismiss_gpu_notice())),
    )
}

fn rail_item(s: &State, key: &str, words: &str, active: bool, on_press: impl Fn(&mut State) + 'static) -> El {
    let p = pal(s.dark());
    let label = tr(s.lang, words);
    col().key(key).role("button").label(label.clone()).focusable(true).px(4.0).py(10.0).radius(8.0).w_full().items_center()
        .fill(if active { p.raised } else { p.surface }).hover(p.text.alpha(0.08)).on_press(on_press)
        .child(text(label).font(type_::LABEL).color(if active { p.beam_text } else { p.text }))
}

thread_local! {
    /// The approved app icon (`assets/icon/icon-512.png`), decoded once; the cache stays with it.
    static ICON: (rune::ImageCache, rune::Image) = {
        let cache = rune::ImageCache::new(std::sync::Arc::new(|| {}));
        let image = cache.load(&include_bytes!("../../assets/icon/icon-512.png")[..]);
        let _ = image.wait();
        (cache, image)
    };
}

/// The app icon at 32 pt: the beam, one tungsten light cone across a graphite rounded square.
fn logo(_: &State) -> El {
    ICON.with(|(_, image)| col().key("shell/logo").role("img").label("Sorot").w(32.0).h(32.0).radius(8.0).pixels(image.pixels()))
}

/// The rail holds only screens that exist, the same ones the View menu lists.
pub fn with_rail(s: &State, content: El) -> El {
    let p = pal(s.dark());
    let screen = s.screen();
    let on = |a: &[Screen]| a.contains(&screen);
    let mut rail = col().key("shell/rail").role("navigation").label("Sorot").w(64.0).gap(4.0).px(4.0).py(12.0).items_center().fill(p.surface)
        .child(logo(s))
        .child(rail_item(s, "shell/rail/home", "shell.home", on(&[Screen::Home, Screen::Job]), |s| s.go_home()));
    if let Some(video) = s.clips.video_id.clone() {
        rail = rail.child(rail_item(s, "shell/rail/clips", "shell.clips", on(&[Screen::Clips, Screen::Editor, Screen::Publish]), move |s| s.show_clips(&video)));
    }
    rail = rail
        .child(rail_item(s, "shell/rail/discover", "shell.discover", on(&[Screen::Discover]), |s| s.show(Page::Discover)))
        .child(rail_item(s, "shell/rail/generate", "shell.generate", on(&[Screen::Generate]), |s| s.show(Page::Generate)))
        .child(rail_item(s, "shell/rail/learning", "shell.learning", on(&[Screen::Learning]), |s| s.show(Page::Learning)))
        .child(rail_item(s, "shell/rail/settings", "shell.settings", on(&[Screen::General, Screen::Connections, Screen::GenerateSettings]), |s| s.show(Page::Connections)));
    row().w_full().grow(1.0).shrink().child(rail).child(col().grow(1.0).shrink().center().child(content))
}

/// "Close Sorot?" while jobs run: keep running, wait, or cancel and quit.
pub fn close_dialog(s: &State) -> El {
    let p = pal(s.dark());
    let l = s.lang;
    let n = s.running_jobs();
    let mut actions = col().gap(8.0);
    if s.background_ok {
        actions = actions.child(button(s.dark(), "close/background", &tr(l, "shell.close.background"), true, |s: &mut State| s.answer_close(CloseAnswer::Background)));
    }
    actions = actions
        .child(button(s.dark(), "close/wait", &tr(l, "shell.close.wait"), !s.background_ok, |s: &mut State| s.answer_close(CloseAnswer::Wait)))
        .child(button(s.dark(), "close/cancel-quit", &tr(l, "shell.close.cancel-quit"), false, |s: &mut State| s.answer_close(CloseAnswer::CancelAndQuit)));
    let label = trf(l, "shell.close.label", &[("n", n.to_string().as_str())]);
    col().key("close/dialog").role("alertdialog").label(label).gap(16.0).padding(24.0).max_w(460.0).fill(p.raised).border(1.0, p.divider).radius(10.0)
        .child(text(tr(l, "shell.close.title")).role("heading").level(1).font(type_::TITLE).color(p.text))
        .child(text(trf(l, "shell.close.body", &[("n", n.to_string().as_str())])).key("close/body").font(type_::BODY).color(p.muted).wrap())
        .child(actions)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAnswer {
    Background,
    Wait,
    CancelAndQuit,
}
