//! Which modes the user can start. Clipping needs only the machine; Generate also needs an AI
//! connection (constitution IV: a mode that requires one shows as unavailable without it).

use crate::readiness::{Item, clipping_allowed, generate_allowed};

/// One connection as the screens know it: saved and answering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Link {
    pub configured: bool,
    pub healthy: bool,
}

impl Link {
    fn usable(self) -> bool {
        self.configured && self.healthy
    }
}

/// Tebar is left out on purpose: it only publishes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Connections {
    pub llm: Link,
    pub jev: Link,
}

/// Generate needs the clipping gate, the browser, and an LLM or Jev that is configured and healthy.
pub fn generate_available(connections: &Connections, readiness: &[Item]) -> bool {
    (connections.llm.usable() || connections.jev.usable()) && generate_allowed(readiness)
}

/// Clipping never looks at connections; the parameter keeps that visible and provable.
pub fn clipping_available(_connections: &Connections, readiness: &[Item]) -> bool {
    clipping_allowed(readiness)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::readiness::{ItemId, ItemState};

    #[test]
    fn availability_table() {
        let item = |id, ok: bool| Item { id, required: id == ItemId::Ffmpeg, state: if ok { ItemState::Ok } else { ItemState::Missing { fixable: true } } };
        let link = |configured, healthy| Link { configured, healthy };
        let conns = |llm, jev| Connections { llm, jev };
        let (up, down, unsaved) = (link(true, true), link(true, false), link(false, false));
        // (ffmpeg ok, browser ok, connections, clipping, generate)
        for (ffmpeg, browser, c, clip, generate) in [
            (true, true, conns(up, unsaved), true, true),
            (true, true, conns(unsaved, up), true, true),
            (true, true, conns(down, down), true, false),
            (true, true, conns(unsaved, unsaved), true, false),
            (true, false, conns(up, up), true, false),
            (false, true, conns(up, up), false, false),
        ] {
            let items = [item(ItemId::Ffmpeg, ffmpeg), item(ItemId::GenerateBrowser, browser)];
            assert_eq!((clipping_available(&c, &items), generate_available(&c, &items)), (clip, generate), "{ffmpeg} {browser} {c:?}");
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;
    use crate::readiness::{ItemId, ItemState};

    fn any_link() -> Link {
        Link { configured: kani::any(), healthy: kani::any() }
    }

    fn any_items() -> [Item; 2] {
        let state = |ok: bool| if ok { ItemState::Ok } else { ItemState::Missing { fixable: false } };
        [
            Item { id: ItemId::Ffmpeg, required: true, state: state(kani::any()) },
            Item { id: ItemId::GenerateBrowser, required: kani::any(), state: state(kani::any()) },
        ]
    }

    #[kani::proof]
    fn no_connection_state_changes_clipping() {
        let items = any_items();
        let (a, b) = (Connections { llm: any_link(), jev: any_link() }, Connections { llm: any_link(), jev: any_link() });
        assert_eq!(clipping_available(&a, &items), clipping_available(&b, &items));
    }

    #[kani::proof]
    fn generate_needs_a_usable_ai_connection() {
        let c = Connections { llm: any_link(), jev: any_link() };
        if generate_available(&c, &any_items()) {
            assert!((c.llm.configured && c.llm.healthy) || (c.jev.configured && c.jev.healthy));
        }
    }
}
