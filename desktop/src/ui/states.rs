//! The one empty / loading / error block (R-27): what is going on, and the next step.

use rune::tok::{self, type_};
use rune::{El, col, text};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Kind {
    #[default]
    Empty,
    Loading,
    Error,
}

/// A button under the text: `(key, label, handler)`.
pub type Action<S> = (&'static str, &'static str, fn(&mut S));

/// `key` names the block (`{key}/cause`, `{key}/next` inside). An error is announced at once
/// (role `alert`); empty and loading are polite (`status`).
pub fn state_block<S: 'static>(dark: bool, key: &str, kind: Kind, cause: &str, next: &str, action: Option<Action<S>>) -> El {
    let t = tok::theme(dark);
    let role = if kind == Kind::Error { "alert" } else { "status" };
    let mut block = col().key(key).role(role).label(format!("{cause} {next}")).gap(8.0).items_center().max_w(420.0)
        .child(text(cause).key(format!("{key}/cause")).font(type_::TITLE).color(t.text).wrap())
        .child(text(next).key(format!("{key}/next")).font(type_::BODY).color(t.text_secondary).wrap());
    if let Some((action_key, label, on_press)) = action {
        block = block.child(
            col().key(action_key).role("button").label(label).focusable(true).padding(8.0).radius(6.0)
                .fill(t.card).border(1.0, t.card_border).on_press(on_press).child(text(label).font(type_::LABEL).color(t.text)),
        );
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Cx, Env, Runtime};
    use serde_json::Value;

    #[derive(Default)]
    struct S {
        kind: Kind,
        pressed: bool,
    }

    fn view(s: &S, _: &mut Cx<S>) -> El {
        let action: Option<Action<S>> = (s.kind == Kind::Error).then_some(("block/act", "Restart engine", |s: &mut S| s.pressed = true));
        col().w_full().h_full().center().child(state_block(true, "block", s.kind, "Cause", "Next step", action))
    }

    fn find<'a>(tree: &'a Value, name: &str) -> Option<&'a Value> {
        if tree["name"] == name {
            return Some(tree);
        }
        tree["children"].as_array()?.iter().find_map(|c| find(c, name))
    }

    /// The three states, each with the role and name a screen reader hears; the action works.
    #[test]
    fn each_state_has_its_role_name_and_next_step() {
        for (kind, role) in [(Kind::Empty, "status"), (Kind::Loading, "status"), (Kind::Error, "alert")] {
            let mut rt = Runtime::new(S { kind, pressed: false }, view, (400.0, 300.0), Env { system_dark: true, scale: 1.0 });
            rt.frame(0.0);
            let tree = rt.accessibility_json();
            let block = find(&tree, "Cause Next step").unwrap_or_else(|| panic!("{kind:?}: {tree}"));
            assert_eq!(block["role"], role, "{kind:?}");
            if kind == Kind::Error {
                let (x, y) = rt.find("block/act").unwrap();
                rt.pointer_down(x, y);
                rt.pointer_up(x, y);
                rt.frame(0.0);
                assert!(rt.state.pressed);
                assert!(find(&rt.accessibility_json(), "Restart engine").is_some());
            }
        }
    }
}
