//! The results sheet: log how a posted clip did. The viral score is by the day, so the post time is
//! required. Learning shows it under a clip; the clips screen can open the same sheet.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::types::Metrics;
use crate::screens::panels::{Host, answer, go};
use crate::ui::form::{Tone, btn, field, note};
use crate::ui::kit::pal;

pub const METRICS: [(&str, &str); 5] = [("views", "Views"), ("likes", "Likes"), ("comments", "Comments"), ("shares", "Shares"), ("saves", "Saves")];

pub struct Sheet {
    /// The clip the sheet is open for; `None` when closed.
    pub clip_id: Option<String>,
    pub title: String,
    pub numbers: [TextEdit; 5],
    pub posted_at: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
    /// The engine's score for what was just saved, in percent; `Some(None)` when it gave none.
    pub saved: Option<Option<f64>>,
}

impl Default for Sheet {
    fn default() -> Self {
        Sheet { clip_id: None, title: String::new(), numbers: std::array::from_fn(|_| TextEdit::new("")), posted_at: TextEdit::new(""), busy: false, error: None, saved: None }
    }
}

/// `2026-11-14 19:00` (UTC) as the ISO text the engine wants, or `None` when it is not a date and time.
pub fn iso_utc(s: &str) -> Option<String> {
    let s = s.trim().trim_end_matches('Z').replace(' ', "T");
    let (date, time) = s.split_once('T')?;
    let num = |part: &str, len: usize| (part.len() == len && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse::<u32>().ok()).flatten();
    let d: Vec<&str> = date.split('-').collect();
    let t: Vec<&str> = time.split(':').collect();
    let ([y, mo, day], true) = (<[&str; 3]>::try_from(d).ok()?, matches!(t.len(), 2 | 3)) else { return None };
    num(y, 4)?;
    let (mo, day, hour, min) = (num(mo, 2)?, num(day, 2)?, num(t[0], 2)?, num(t[1], 2)?);
    let sec = t.get(2).map_or(Some(0), |x| num(x, 2))?;
    ((1..=12).contains(&mo) && (1..=31).contains(&day) && hour < 24 && min < 60 && sec < 60).then(|| format!("{date}T{hour:02}:{min:02}:{sec:02}Z"))
}

impl Sheet {
    /// What the sheet holds as the engine wants it, or the words for what is wrong.
    pub fn metrics(&self) -> Result<Metrics, String> {
        if self.posted_at.text.trim().is_empty() {
            return Err("Add when it was posted. The score counts days online, so this is required.".into());
        }
        let posted_at = iso_utc(&self.posted_at.text).ok_or("Write the post time as 2026-11-14 19:00 (UTC).")?;
        let mut n = [0u64; 5];
        for (((_, label), edit), slot) in METRICS.iter().zip(&self.numbers).zip(&mut n) {
            let t = edit.text.trim();
            *slot = if t.is_empty() { 0 } else { t.parse().map_err(|_| format!("{label} must be a whole number."))? };
        }
        Ok(Metrics { views: n[0], likes: n[1], comments: n[2], shares: n[3], saves: n[4], posted_at })
    }
}

/// Opens an empty sheet for a clip.
pub fn open<H: Host>(h: &mut H, clip_id: &str, title: &str) {
    h.panels_mut().feedback = Sheet { clip_id: Some(clip_id.into()), title: title.into(), ..Sheet::default() };
}

pub fn close<H: Host>(h: &mut H) {
    h.panels_mut().feedback = Sheet::default();
}

/// Sends the numbers; Learning then shows the new row and the new count.
pub fn submit<H: Host>(h: &mut H) {
    let s = &mut h.panels_mut().feedback;
    let Some(clip) = s.clip_id.clone() else { return };
    let metrics = match s.metrics() {
        Ok(m) => m,
        Err(why) => return s.error = Some(why),
    };
    (s.busy, s.error) = (true, None);
    go(h, move |e| {
        let saved = e.submit_feedback(&clip, &metrics);
        let fresh = saved.is_ok().then(|| (e.feedback(), e.weights()));
        answer(saved, move |p, r| {
            p.feedback.busy = false;
            match r {
                Ok(done) => {
                    p.feedback.saved = Some(done.viral_score.map(|v| v * 100.0));
                    if let Some((Ok(results), Ok(weights))) = fresh {
                        (p.learning.results, p.learning.weights) = (results, Some(weights));
                        p.learning.waiting.retain(|w| Some(&w.clip_id) != p.feedback.clip_id.as_ref());
                    }
                }
                Err(why) => p.feedback.error = Some(why),
            }
        })
    });
}

pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let p = pal(dark);
    let s = &h.panels().feedback;
    let mut numbers = row().gap(8.0).w_full();
    for (i, (name, label)) in METRICS.iter().enumerate() {
        numbers = numbers.child(field(dark, &format!("feedback/{name}"), label, &s.numbers[i], "0", false, edit_access(move |h: &mut H| &mut h.panels_mut().feedback.numbers[i])));
    }
    let mut sheet = col().key("feedback/sheet").role("group").label("Log results").gap(12.0).padding(16.0).w_full().fill(p.raised).radius(8.0)
        .child(text(format!("Results for {}", s.title)).key("feedback/for").font(type_::TITLE).color(p.text).wrap())
        .child(field(dark, "feedback/posted-at", "Posted at (UTC, like 2026-11-14 19:00)", &s.posted_at, "Required", false, edit_access(move |h: &mut H| &mut h.panels_mut().feedback.posted_at)))
        .child(numbers)
        .child(text("The score is counted per day online, so the post time matters.").font(type_::LABEL).color(p.muted).wrap())
        .child(row().gap(8.0)
            .child(btn(dark, "feedback/submit", "Save results", true, !s.busy, submit::<H>))
            .child(btn(dark, "feedback/close", "Close", false, true, close::<H>)));
    if let Some(why) = &s.error {
        sheet = sheet.child(note(dark, "feedback/error", Tone::Bad, why));
    }
    match s.saved {
        Some(Some(score)) => sheet = sheet.child(note(dark, "feedback/saved", Tone::Ok, &format!("Saved. Viral score {score:.1}%."))),
        Some(None) => sheet = sheet.child(note(dark, "feedback/saved", Tone::Ok, "Saved. The engine has no score for it yet.")),
        None => {}
    }
    sheet
}
