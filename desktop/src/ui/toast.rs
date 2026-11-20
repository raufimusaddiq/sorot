//! Toasts on screen, driven by `core::toast`: six seconds, paused while the pointer is on one.
//! A toast is an overlay: it picks the first of three anchors that misses every focused control.

use rune::tok::{self, type_};
use rune::{Cx, El, col, row, text};
use sorot_desktop_core::toast::{Toast, ToastKind};

use crate::app::State;
use crate::ui::focus;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastItem {
    pub toast: Toast,
    pub hovered: bool,
}

fn hits(a: [f32; 4], b: [f32; 4]) -> bool {
    let x = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let y = (a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1]);
    x > 0.0 && y > 0.0
}

/// Size of this frame's stack, not last frame's: a stack growing from one to several toasts must
/// pick an anchor for the size it is about to have, not the one it had before. Each row is 10 pt
/// of padding above and below a 13 pt line; the stack adds 12 pt of padding and 6 pt between rows.
fn size(items: &[ToastItem]) -> [f32; 2] {
    let n = items.len().max(1) as f32;
    let chars = items.iter().map(|i| i.toast.text.chars().count()).max().unwrap_or(20) as f32;
    [24.0 + chars * 7.4, 24.0 + n * 36.0 + (n - 1.0) * 6.0]
}

/// Where the stack goes this frame: first free anchor, else above every control it would hit.
fn place(items: &[ToastItem], s: &State, cx: &Cx<State>) -> [f32; 2] {
    let [w, h] = cx.layout_size("app/root").unwrap_or([1100.0, 720.0]);
    let [tw, th] = size(items);
    let anchors = [
        [w - 16.0 - tw, h - 16.0 - th],
        [80.0, h - 16.0 - th],
        [w - 16.0 - tw, 40.0],
    ];
    let rect = |p: [f32; 2]| [p[0], p[1], tw, th];
    let controls: Vec<[f32; 4]> = focus::keys(s).iter().filter_map(|k| cx.window_layout(k)).filter(|r| r[2] > 0.0 && r[3] > 0.0).collect();
    let clear = |p: &[f32; 2]| !controls.iter().any(|c| hits(rect(*p), *c));
    if let Some(p) = anchors.into_iter().find(clear) {
        return p;
    }
    // Nudge above the topmost control the bottom-right anchor would hit, then check again: a
    // shorter control higher up must not be covered by the nudge.
    let mut at = anchors[0];
    for _ in 0..=controls.len() {
        let top = controls.iter().filter(|c| hits(rect(at), **c)).map(|c| c[1]).fold(f32::INFINITY, f32::min);
        if !top.is_finite() {
            return at;
        }
        at = [at[0], (top - th - 8.0).max(40.0)];
        if clear(&at) || at[1] <= 40.0 {
            return at;
        }
    }
    at
}

/// The stack overlays the window. A failed toast is announced at once (`alert`).
pub fn toast_stack(dark: bool, items: &[ToastItem], s: &State, cx: &Cx<State>) -> El {
    let t = tok::theme(dark);
    let [x, y] = place(items, s, cx);
    let mut stack = col().key("toast/stack").gap(6.0).padding(12.0).items_end().absolute(x, y);
    for (i, item) in items.iter().enumerate() {
        let (role, mark) = match item.toast.kind {
            ToastKind::Failed => ("alert", "Failed"),
            ToastKind::Done => ("status", "Done"),
            ToastKind::Info => ("status", "Note"),
        };
        stack = stack.child(
            row().key(format!("toast/{i}")).role(role).label(format!("{mark}: {}", item.toast.text)).gap(8.0).padding(10.0).radius(8.0)
                .fill(t.card).border(1.0, t.card_border)
                .on_hover_change(move |s: &mut State, inside, _| {
                    if let Some(item) = s.toasts.get_mut(i) {
                        item.hovered = inside;
                    }
                })
                .child(text(&item.toast.text).font(type_::BODY).color(t.text)),
        );
    }
    stack
}
