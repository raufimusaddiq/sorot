//! The menu bar and the one list of actions behind it. The rail, the menus and the command palette
//! (`palette.rs`) offer the same destinations, so nothing exists only in one of them.
//!
//! macOS gets the system menu bar (`native_items`, installed by `app::run`); Windows draws the bar
//! in the window and drops each menu down natively; Linux draws both.

use rune::tok::type_;
use rune::{El, MenuItem, PopupItem, PopupMenu, Tx, col, row, text};

use sorot_desktop_core::prefs::Theme;
use crate::app::State;
use crate::i18n::{Lang, tr};
use crate::screens::panels::{Host, Page};
use crate::ui::kit::pal;

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

pub type Act = fn(&mut State, &mut Tx);

/// One list of a menu: `(key, i18n key, what it does)`. The View menu lists the rail's places.
pub fn menu_items(s: &State, menu: Menu) -> Vec<(&'static str, &'static str, Act)> {
    items_of(menu, s.clips.video_id.is_some())
}

/// `menu_items` with Clips listed or not: the rail shows it once a video is open.
fn items_of(menu: Menu, clips: bool) -> Vec<(&'static str, &'static str, Act)> {
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
        Menu::View => {
            let mut v: Vec<(&'static str, &'static str, Act)> = vec![("home", "shell.home", |s, _| s.go_home())];
            if clips {
                v.push(("clips", "shell.clips", |s, _| {
                    if let Some(video) = s.clips.video_id.clone() {
                        s.show_clips(&video);
                    }
                }));
            }
            v.extend([
                ("discover", "shell.discover", (|s, _| s.show(Page::Discover)) as Act),
                ("generate", "shell.generate", |s, _| s.show(Page::Generate)),
                ("learning", "shell.learning", |s, _| s.show(Page::Learning)),
                ("settings", "shell.settings", |s, _| s.show(Page::Connections)),
                ("theme", "menu.theme", |s, _| s.set_theme(if s.dark() { Theme::Light } else { Theme::Dark })),
            ]);
            v
        }
        Menu::Window => vec![("hide", "menu.hide", |s, _| s.hide_window())],
        Menu::Help => vec![("diagnostic", "menu.diagnostic", |s, _| s.export_diagnostic()), ("restart", "menu.restart", |s, _| s.restart_engine())],
    }
}

/// Every action of every menu, in menu order: what the command palette lists. An action's id is its
/// place in this list.
pub fn actions(s: &State) -> Vec<(&'static str, &'static str, Act)> {
    Menu::ALL.into_iter().flat_map(|m| menu_items(s, m)).collect()
}

/// Whether menus drop down as the system's pop-up menus: Windows and macOS, and every headless run
/// (which keeps the open menu in its tree for a script to pick from).
fn pops(s: &State) -> bool {
    #[cfg(any(test, feature = "headless", debug_assertions))]
    if rune::tooling::headless_run().is_some() {
        return true;
    }
    s.native_popups
}

impl State {
    /// A press on a menu of the bar: the system's pop-up menu under it, or the in-window list.
    pub fn press_menu(&mut self, m: Menu, tx: &mut Tx) {
        if !pops(self) {
            self.menu_open = if self.menu_open == Some(m) { None } else { Some(m) };
            return;
        }
        let items = menu_items(self, m);
        let menu = PopupMenu::new().items(items.iter().map(|(key, words, _)| PopupItem::new(*key, tr(self.lang, words))));
        tx.popup_menu(menu, format!("shell/menu/{}", m.id()), move |s: &mut State, picked: Option<&str>, tx: &mut Tx| {
            if let Some((_, _, act)) = picked.and_then(|key| menu_items(s, m).into_iter().find(|(k, ..)| *k == key)) {
                act(s, tx);
            }
        });
    }
}

/// The bar across the top: five menus. On macOS the system draws it instead, so the bar is empty.
pub fn menu_bar(s: &State) -> El {
    let p = pal(s.dark());
    if s.system_menu_bar {
        return row().key("shell/menubar").w_full().h(0.0);
    }
    let mut bar = row().key("shell/menubar").role("menubar").label("Sorot").gap(4.0).padding(4.0).items_center().w_full().h(32.0).fill(p.bg);
    for m in Menu::ALL {
        let open = s.menu_open == Some(m);
        let label = tr(s.lang, &format!("menu.{}", m.id()));
        bar = bar.child(
            col().key(format!("shell/menu/{}", m.id())).role("menuitem").label(label.clone()).focusable(true).px(12.0).py(6.0).radius(6.0)
                .fill(if open { p.raised } else { p.bg }).hover(p.text.alpha(0.08)).on_press_tx(move |s: &mut State, tx: &mut Tx| s.press_menu(m, tx))
                .child(text(label).font(type_::LABEL).color(p.text)),
        );
    }
    bar
}

/// The open menu's in-window list, under the bar (where no system pop-up exists); pressing an item
/// runs it and closes the list.
pub fn menu_list(s: &State) -> Option<El> {
    let m = s.menu_open?;
    let p = pal(s.dark());
    let mut list = col().key("shell/menu-list").role("menu").label(tr(s.lang, &format!("menu.{}", m.id()))).gap(2.0).padding(6.0).w(280.0).fill(p.raised).border(1.0, p.divider).radius(8.0);
    for (key, words, act) in menu_items(s, m) {
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

/// The same menus as the system menu bar's items (macOS): each action under its menu, Clips included (pressing it
/// with no video open does nothing, as the system menu cannot change with the screen). The words follow `lang` at
/// the time the menus are set.
pub fn native_items(lang: Lang) -> Vec<MenuItem<State>> {
    native_entries(lang).into_iter().map(|(id, title, menu, act)| MenuItem::new(title, act).id(id).menu(menu)).collect()
}

/// What `native_items` builds from: `(id "menu/key", title, menu title, action)`.
pub fn native_entries(lang: Lang) -> Vec<(String, String, String, Act)> {
    let mut out = vec![];
    for m in Menu::ALL {
        let menu = tr(lang, &format!("menu.{}", m.id()));
        for (key, words, act) in items_of(m, true) {
            out.push((format!("{}/{key}", m.id()), tr(lang, words), menu.clone(), act));
        }
    }
    out
}
