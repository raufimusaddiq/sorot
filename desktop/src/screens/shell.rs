//! What surrounds every screen: the left rail, the connection banner and the close dialog.

use rune::tok::type_;
use rune::{El, Tx, col, row, text};

use crate::app::{Conn, Screen, State};
use crate::i18n::tr;
use crate::screens::panels::{Host, Page};
use crate::ui::kit::{button, pal};

/// Shown while the engine is lost or failed; `None` when the connection is fine.
pub fn banner(s: &State) -> Option<El> {
    let p = pal(s.dark);
    let words = match &s.conn {
        Conn::Lost => "Lost the connection to the engine. Sorot is reconnecting; running jobs keep their state.",
        Conn::Failed(_) => "The engine is not running. Restart it, or export a report for support.",
        Conn::Starting | Conn::Ready => return None,
    };
    Some(
        row().key("shell/banner").role("alert").label(words).gap(12.0).padding(12.0).items_center().w_full().fill(p.raised).border(1.0, p.skip)
            .child(text(words).key("shell/banner/text").font(type_::BODY).color(p.text).wrap().grow(1.0))
            .child(button(s.dark, "engine/restart", "Restart engine", true, |s: &mut State| s.restart_engine()))
            .child(button(s.dark, "shell/export-diagnostic", "Export diagnostic report", false, |s: &mut State| s.export_diagnostic())),
    )
}

/// The one notice on a machine whose graphics run on the CPU; dismissing it keeps effects off.
pub fn gpu_notice(s: &State) -> Option<El> {
    if !s.gpu_notice {
        return None;
    }
    let p = pal(s.dark);
    let words = tr(s.lang, "gpu.notice");
    Some(
        row().key("shell/gpu-notice").role("status").label(words.clone()).gap(12.0).padding(12.0).items_center().w_full().fill(p.raised).border(1.0, p.divider)
            .child(text(words).key("shell/gpu-notice/text").font(type_::BODY).color(p.text).wrap().grow(1.0))
            .child(button(s.dark, "shell/gpu-notice/dismiss", &tr(s.lang, "gpu.dismiss"), false, |s: &mut State| s.dismiss_gpu_notice())),
    )
}

/// The menus of the menu bar, left to right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Menu {
    File,
    Edit,
    View,
    Window,
    Help,
}

impl Menu {
    pub const ALL: [Menu; 5] = [Menu::File, Menu::Edit, Menu::View, Menu::Window, Menu::Help];

    pub fn id(self) -> &'static str {
        match self {
            Menu::File => "file",
            Menu::Edit => "edit",
            Menu::View => "view",
            Menu::Window => "window",
            Menu::Help => "help",
        }
    }
}

type Act = fn(&mut State, &mut Tx);

/// One list of a menu: `(key, i18n key, what it does)`. The same destinations the rail has, in the
/// View menu; nothing here exists only in a menu.
pub fn menu_items(menu: Menu) -> Vec<(&'static str, &'static str, Act)> {
    match menu {
        Menu::File => vec![
            ("new", "menu.new", |s, _| s.go_home()),
            ("quit", "menu.quit", |s, tx| {
                if s.closing() {
                    tx.quit();
                }
            }),
        ],
        Menu::Edit => vec![("edit-clip", "menu.edit-clip", |s, _| {
            if let Some(id) = s.selected_clip().map(|c| c.id.clone()) {
                s.open_editor(&id);
            }
        })],
        Menu::View => vec![
            ("home", "shell.home", |s, _| s.go_home()),
            ("discover", "shell.discover", |s, _| s.show(Page::Discover)),
            ("learning", "shell.learning", |s, _| s.show(Page::Learning)),
            ("settings", "shell.settings", |s, _| s.show(Page::Connections)),
            ("theme", "menu.theme", |s, _| s.dark = !s.dark),
        ],
        Menu::Window => vec![("hide", "menu.hide", |s, _| s.hide_window())],
        Menu::Help => vec![("diagnostic", "menu.diagnostic", |s, _| s.export_diagnostic()), ("restart", "menu.restart", |s, _| s.restart_engine())],
    }
}

/// The bar across the top: five menus, and the open one's list under it.
pub fn menu_bar(s: &State) -> El {
    let p = pal(s.dark);
    let mut bar = row().key("shell/menubar").role("menubar").label("Sorot").gap(4.0).padding(4.0).items_center().w_full().h(32.0).fill(p.bg);
    for m in Menu::ALL {
        let open = s.menu_open == Some(m);
        let label = tr(s.lang, &format!("menu.{}", m.id()));
        bar = bar.child(
            col().key(format!("shell/menu/{}", m.id())).role("menuitem").label(label.clone()).focusable(true).px(12.0).py(6.0).radius(6.0)
                .fill(if open { p.raised } else { p.bg }).hover(p.text.alpha(0.08)).on_press(move |s: &mut State| s.menu_open = if open { None } else { Some(m) })
                .child(text(label).font(type_::LABEL).color(p.text)),
        );
    }
    bar
}

/// The open menu's list, under the bar; pressing an item runs it and closes the list.
pub fn menu_list(s: &State) -> Option<El> {
    let m = s.menu_open?;
    let p = pal(s.dark);
    let mut list = col().key("shell/menu-list").role("menu").label(tr(s.lang, &format!("menu.{}", m.id()))).gap(2.0).padding(6.0).w(280.0).fill(p.raised).border(1.0, p.divider).radius(8.0);
    for (key, words, act) in menu_items(m) {
        let label = tr(s.lang, words);
        list = list.child(
            col().key(format!("shell/menu/{}/{key}", m.id())).role("menuitem").label(label.clone()).focusable(true).px(10.0).py(8.0).radius(6.0)
                .hover(p.text.alpha(0.08)).on_press_tx(move |s: &mut State, tx: &mut Tx| {
                    s.menu_open = None;
                    act(s, tx);
                }).child(text(label).font(type_::BODY).color(p.text)),
        );
    }
    Some(row().w_full().padding(0.0).child(col().w(8.0).h(1.0)).child(list))
}

fn rail_item(s: &State, key: &str, words: &str, active: bool, on_press: impl Fn(&mut State) + 'static) -> El {
    let p = pal(s.dark);
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
    let p = pal(s.dark);
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
        .child(rail_item(s, "shell/rail/learning", "shell.learning", on(&[Screen::Learning]), |s| s.show(Page::Learning)))
        .child(rail_item(s, "shell/rail/settings", "shell.settings", on(&[Screen::Connections, Screen::GenerateSettings]), |s| s.show(Page::Connections)));
    row().w_full().grow(1.0).shrink().child(rail).child(col().grow(1.0).shrink().center().child(content))
}

/// "Close Sorot?" while jobs run: keep running, wait, or cancel and quit.
pub fn close_dialog(s: &State) -> El {
    let p = pal(s.dark);
    let n = s.running_jobs();
    let mut actions = col().gap(8.0);
    if s.background_ok {
        actions = actions.child(button(s.dark, "close/background", "Keep running in the background", true, |s: &mut State| s.answer_close(CloseAnswer::Background)));
    }
    actions = actions
        .child(button(s.dark, "close/wait", "Wait for the jobs, then close", !s.background_ok, |s: &mut State| s.answer_close(CloseAnswer::Wait)))
        .child(button(s.dark, "close/cancel-quit", "Cancel the jobs and quit", false, |s: &mut State| s.answer_close(CloseAnswer::CancelAndQuit)));
    let label = format!("Close Sorot? {n} job(s) are still running.");
    col().key("close/dialog").role("alertdialog").label(label).gap(16.0).padding(24.0).max_w(460.0).fill(p.raised).border(1.0, p.divider).radius(10.0)
        .child(text("Close Sorot?").role("heading").level(1).font(type_::TITLE).color(p.text))
        .child(text(format!("{n} job(s) are still running. Pick what happens to them.")).key("close/body").font(type_::BODY).color(p.muted).wrap())
        .child(actions)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAnswer {
    Background,
    Wait,
    CancelAndQuit,
}
