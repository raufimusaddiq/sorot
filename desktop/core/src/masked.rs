//! A connection's key field. It shows the engine's masked key until the user types, and sends
//! only what the user typed.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyField {
    masked: String,
    typed: Option<String>,
}

impl KeyField {
    pub fn new(masked: &str) -> Self {
        Self { masked: masked.into(), typed: None }
    }

    /// The text on screen: what the user typed, else the engine's masked value.
    pub fn displayed(&self) -> &str {
        self.typed.as_deref().unwrap_or(&self.masked)
    }

    /// The user edits the field (an empty edit goes back to showing the masked key).
    pub fn type_text(&mut self, text: &str) {
        self.typed = (!text.is_empty()).then(|| text.to_string());
    }

    /// What goes to the engine: the user's own input, never the masked value.
    pub fn outgoing(&self) -> Option<&str> {
        self.typed.as_deref()
    }

    /// The engine answered (after a save, or a fresh load): its masked key replaces any input.
    pub fn receive(&mut self, masked: &str) {
        *self = Self::new(masked);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_masked_until_typed_and_sends_only_typed() {
        let mut f = KeyField::new("sk-****1234");
        assert_eq!((f.displayed(), f.outgoing()), ("sk-****1234", None));
        f.type_text("sk-new");
        assert_eq!((f.displayed(), f.outgoing()), ("sk-new", Some("sk-new")));
        f.type_text("");
        assert_eq!((f.displayed(), f.outgoing()), ("sk-****1234", None));
        f.type_text("x");
        f.receive("sk-****9999");
        assert_eq!((f.displayed(), f.outgoing()), ("sk-****9999", None));
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(6)]
    fn display_is_the_masked_value_or_the_users_input() {
        let mut f = KeyField::new("m1");
        let mut last_typed: Option<&str> = None;
        let mut last_masked = "m1";
        for _ in 0..3 {
            match kani::any::<u8>() % 3 {
                0 => {
                    f.type_text("u1");
                    last_typed = Some("u1");
                }
                1 => {
                    f.type_text("");
                    last_typed = None;
                }
                _ => {
                    f.receive("m2");
                    last_masked = "m2";
                    last_typed = None;
                }
            }
            assert!(f.displayed() == last_masked || Some(f.displayed()) == last_typed);
            assert!(f.outgoing().is_none() || f.outgoing() == last_typed);
        }
    }
}
