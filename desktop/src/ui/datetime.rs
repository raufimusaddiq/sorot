//! A date and time picked in boxes: day, month, year, hour and minute, in UTC. The boxes are
//! checked as a real calendar moment (`core::datetime`), so a day the month does not have or a
//! time still to come is named, not guessed at. The engine gets ISO text.

use rune::tok::type_;
use rune::{El, TextEdit, edit_access, row, text};
use sorot_desktop_core::datetime::{Stamp, Why};

use crate::i18n::{Lang, tr};
use crate::ui::form::{btn, field};
use crate::ui::kit::pal;

pub struct DateBoxes {
    pub day: TextEdit,
    pub month: TextEdit,
    pub year: TextEdit,
    pub hour: TextEdit,
    pub minute: TextEdit,
    /// Seconds since the epoch the "now" button fills in and a future time is measured against.
    pub now: i64,
}

impl Default for DateBoxes {
    fn default() -> Self {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        DateBoxes { day: TextEdit::new(""), month: TextEdit::new(""), year: TextEdit::new(""), hour: TextEdit::new(""), minute: TextEdit::new(""), now }
    }
}

impl DateBoxes {
    /// What the boxes hold, or why it is not a moment.
    pub fn parse(&self) -> Result<Stamp, Why> {
        Stamp::parse(&self.year.text, &self.month.text, &self.day.text, &self.hour.text, &self.minute.text)
    }

    /// True when every box is empty.
    pub fn is_blank(&self) -> bool {
        [&self.day, &self.month, &self.year, &self.hour, &self.minute].iter().all(|b| b.text.trim().is_empty())
    }

    pub fn set(&mut self, s: Stamp) {
        self.day.replace_text(s.day.to_string());
        self.month.replace_text(s.month.to_string());
        self.year.replace_text(s.year.to_string());
        self.hour.replace_text(s.hour.to_string());
        self.minute.replace_text(s.minute.to_string());
    }

    pub fn fill_now(&mut self) {
        self.set(Stamp::from_unix(self.now));
    }

    pub fn clear(&mut self) {
        for b in [&mut self.day, &mut self.month, &mut self.year, &mut self.hour, &mut self.minute] {
            b.replace_text("");
        }
    }

    /// True when the boxes make a moment later than `now`.
    pub fn in_future(&self) -> bool {
        self.parse().is_ok_and(|s| s.unix() > self.now)
    }
}

/// The five boxes under `key`: `{key}/day`, `/month`, `/year`, `/hour`, `/minute`, and `{key}/now`.
pub fn picker<H: 'static>(dark: bool, l: Lang, key: &str, label: &str, boxes: &DateBoxes, get: fn(&mut H) -> &mut DateBoxes) -> El {
    let p = pal(dark);
    let one = |name: &str, text_key: &str, edit: &TextEdit, hint: &str, pick: fn(&mut DateBoxes) -> &mut TextEdit, w: f32| {
        field(dark, &format!("{key}/{name}"), &tr(l, text_key), edit, hint, false, edit_access(move |h: &mut H| pick(get(h)))).w(w)
    };
    let boxes_row = row().gap(8.0).items_end()
        .child(one("day", "date.day", &boxes.day, "DD", |b| &mut b.day, 72.0))
        .child(one("month", "date.month", &boxes.month, "MM", |b| &mut b.month, 72.0))
        .child(one("year", "date.year", &boxes.year, "YYYY", |b| &mut b.year, 96.0))
        .child(one("hour", "date.hour", &boxes.hour, "HH", |b| &mut b.hour, 72.0))
        .child(one("minute", "date.minute", &boxes.minute, "MM", |b| &mut b.minute, 72.0))
        .child(btn(dark, format!("{key}/now"), &tr(l, "date.now"), false, true, move |h: &mut H| get(h).fill_now()));
    rune::col().key(key).role("group").label(label).gap(6.0).w_full()
        .child(text(label).font(type_::LABEL).color(p.muted))
        .child(boxes_row)
        .child(text(tr(l, "date.utc")).font(type_::LABEL).color(p.muted))
}
