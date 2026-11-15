//! What surrounds every screen: the left rail, the connection banner and the close dialog.

use rune::tok::type_;
use rune::{El, col, row, text};

use crate::app::{Conn, State};
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

fn rail_item(s: &State, key: &str, label: &str, page: Page) -> El {
    let p = pal(s.dark);
    col().key(key).role("button").label(label).focusable(true).padding(10.0).radius(6.0).fill(p.raised).on_press(move |s: &mut State| s.show(page))
        .child(text(label).font(type_::LABEL).color(p.text))
}

/// The rail holds only screens that exist.
pub fn with_rail(s: &State, content: El) -> El {
    let p = pal(s.dark);
    let rail = col().key("shell/rail").role("navigation").label("Sorot").w(88.0).h_full().gap(8.0).padding(8.0).fill(p.surface)
        .child(text("Sorot").key("shell/wordmark").font(type_::TITLE).color(p.beam))
        .child(col().key("shell/rail/home").role("button").label("Home").focusable(true).padding(10.0).radius(6.0).fill(p.raised)
            .child(text("Home").font(type_::LABEL).color(p.beam_text)))
        .child(rail_item(s, "shell/rail/discover", "Discover", Page::Discover))
        .child(rail_item(s, "shell/rail/learning", "Learning", Page::Learning))
        .child(rail_item(s, "shell/rail/settings", "Settings", Page::Connections));
    row().w_full().grow(1.0).child(rail).child(col().grow(1.0).h_full().center().child(content))
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
