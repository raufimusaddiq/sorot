//! The command palette (Ctrl or Cmd+K): one field over a list of every action the menus offer.
//! `core::palette_search` ranks the list for what was typed; Up and Down move, Enter runs, Escape
//! closes and focus goes back to where it was.
//!
//! The field and list are the parts of Rune kit's `Combobox` (a search field over rows), built here
//! rather than through `Combobox` itself, whose own fuzzy filter would replace the ranking the
//! palette promises (prefix, then word start, then substring, accents ignored).

use rune::tok::type_;
use rune::{El, Key, TextEdit, Tx, col, edit_access, row, text, text_input};
use sorot_desktop_core::palette_search::{Entry, rank};

use crate::app::State;
use crate::i18n::tr;
use crate::screens::menu_bar::{Act, actions};
use crate::ui::kit::pal;

/// The palette's own state: open or not, what was typed, and the row the arrows chose for that text.
pub struct Palette {
    pub open: bool,
    pub query: TextEdit,
    chosen: (String, usize),
}

impl Default for Palette {
    fn default() -> Self {
        Palette { open: false, query: TextEdit::new(""), chosen: (String::new(), 0) }
    }
}

impl State {
    /// The actions the typed text finds, best first: `(key, words, act)`.
    pub fn palette_hits(&self) -> Vec<(&'static str, String, Act)> {
        let all = actions(self);
        let labels: Vec<String> = all.iter().map(|(_, words, _)| tr(self.lang, words)).collect();
        let entries: Vec<Entry> = labels.iter().enumerate().map(|(i, l)| Entry { id: i as u32, label: l }).collect();
        rank(&self.palette.query.text, &entries).into_iter().map(|id| (all[id as usize].0, labels[id as usize].clone(), all[id as usize].2)).collect()
    }

    /// The highlighted row of `n`: the arrows' choice while the text is the one they chose it for, else the first.
    pub fn palette_row(&self, n: usize) -> usize {
        let (text, at) = &self.palette.chosen;
        if *text == self.palette.query.text { (*at).min(n.saturating_sub(1)) } else { 0 }
    }

    pub fn open_palette(&mut self) {
        self.menu_open = None;
        self.palette = Palette { open: true, ..Palette::default() };
        self.palette.query.focused = true;
    }

    pub fn close_palette(&mut self) {
        self.palette.open = false;
        self.palette.query.focused = false;
    }

    /// Ctrl or Cmd+K.
    pub fn toggle_palette(&mut self) {
        if self.palette.open {
            self.close_palette();
        } else {
            self.open_palette();
        }
    }

    fn palette_move(&mut self, delta: isize) {
        let n = self.palette_hits().len();
        if n > 0 {
            let at = (self.palette_row(n) as isize + delta).rem_euclid(n as isize) as usize;
            self.palette.chosen = (self.palette.query.text.clone(), at);
        }
    }

    /// Runs the row `at` (the highlighted one when `None`) and closes the palette; an empty list does nothing.
    pub fn palette_run(&mut self, at: Option<usize>, tx: &mut Tx) {
        let hits = self.palette_hits();
        let at = at.unwrap_or_else(|| self.palette_row(hits.len()));
        let Some(act) = hits.get(at).map(|h| h.2) else { return };
        self.close_palette();
        act(self, tx);
    }
}

/// The palette over the screen while it is open: a scrim, and the panel as the window's one modal.
pub fn overlay(s: &State) -> Option<El> {
    if !s.palette.open {
        return None;
    }
    let p = pal(s.dark);
    let (title, hint) = (tr(s.lang, "palette.title"), tr(s.lang, "palette.hint"));
    let hits = s.palette_hits();
    let at = s.palette_row(hits.len());
    let mut field = text_input(&s.palette.query, type_::BODY).key("palette/input").label(title.clone()).color(p.text).placeholder(hint, p.muted).single_line().w_full().padding(14.0)
        .on_edit(edit_access(|s: &mut State| &mut s.palette.query))
        .on_submit(|s: &mut State, tx: &mut Tx| s.palette_run(None, tx))
        .on_input_key(|s: &mut State, key: &rune::KeyEvent, _: &mut Tx| match key.key {
            Key::Down => {
                s.palette_move(1);
                true
            }
            Key::Up => {
                s.palette_move(-1);
                true
            }
            _ => false,
        });
    let mut list = col().key("palette/list").role("listbox").label(tr(s.lang, "palette.list")).gap(2.0).padding(6.0).w_full();
    if hits.is_empty() {
        list = list.child(text(tr(s.lang, "palette.empty")).key("palette/empty").role("status").font(type_::BODY).color(p.muted).padding(10.0));
    }
    for (i, (key, words, _)) in hits.iter().enumerate() {
        let row_key = format!("palette/item/{key}");
        if i == at {
            field = field.active_descendant(row_key.clone());
        }
        list = list.child(
            row().key(row_key).role("option").label(words.clone()).checked(i == at).focusable(true).px(10.0).py(9.0).radius(6.0).w_full()
                .fill(if i == at { p.text.alpha(0.08) } else { p.raised }).hover(p.text.alpha(0.08))
                .on_press_tx(move |s: &mut State, tx: &mut Tx| s.palette_run(Some(i), tx))
                .child(text(words.clone()).font(type_::BODY).color(if i == at { p.beam_text } else { p.text })),
        );
    }
    let panel = col().key("palette").role("dialog").label(title).w(560.0).max_w(560.0).fill(p.raised).border(1.0, p.divider).radius(12.0)
        .modal_tx(true, |s: &mut State, _: &mut Tx| s.close_palette())
        .child(field).child(col().w_full().h(1.0).fill(p.divider)).child(list);
    Some(col().key("palette/scrim").w_full().h_full().items_center().padding(96.0).fill(p.bg.alpha(0.6)).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).child(panel))
}
