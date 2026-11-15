//! Toasts on screen, driven by `core::toast`: six seconds, paused while the pointer is on one.

use rune::tok::{self, type_};
use rune::{El, col, row, text};
use sorot_desktop_core::toast::{Toast, ToastKind};

use crate::app::State;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastItem {
    pub toast: Toast,
    pub hovered: bool,
}

/// The stack at the bottom of the window. A failed toast is announced at once (`alert`).
pub fn toast_stack(dark: bool, items: &[ToastItem]) -> El {
    let t = tok::theme(dark);
    let mut stack = col().key("toast/stack").gap(6.0).padding(12.0).items_end();
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
