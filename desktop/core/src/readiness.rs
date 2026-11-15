//! First-run readiness: one state per engine check, and the two gates built on them.

use crate::model::ReadinessItem;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemId {
    Ffmpeg,
    Python,
    WhisperModel,
    Gpu,
    GenerateBrowser,
    Other,
}

impl ItemId {
    pub fn parse(id: &str) -> Self {
        match id {
            "ffmpeg" => Self::Ffmpeg,
            "python" => Self::Python,
            "whisperModel" => Self::WhisperModel,
            "gpu" => Self::Gpu,
            "generateBrowser" => Self::GenerateBrowser,
            _ => Self::Other,
        }
    }
}

/// `Unknown → Checking → Ok | Missing → Fixing → Ok | FixFailed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemState {
    Unknown,
    Checking,
    Ok,
    Missing { fixable: bool },
    Fixing { percent: u8 },
    FixFailed { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: ItemId,
    pub required: bool,
    pub state: ItemState,
}

impl Item {
    pub fn new(id: ItemId, required: bool) -> Self {
        Item { id, required, state: ItemState::Unknown }
    }

    pub fn checking(&mut self) {
        self.state = ItemState::Checking;
    }

    /// The state after the engine's row arrives. A fix that reported progress and now reports
    /// neither progress nor success has failed; the row's `detail` is the reason.
    pub fn apply(&mut self, row: &ReadinessItem) {
        let was_fixing = matches!(self.state, ItemState::Fixing { .. });
        self.required = row.required;
        self.state = match (row.ok, &row.progress) {
            (true, _) => ItemState::Ok,
            (false, Some(p)) => ItemState::Fixing { percent: p.percent.min(100) },
            (false, None) if was_fixing => ItemState::FixFailed { reason: row.detail.clone() },
            (false, None) => ItemState::Missing { fixable: row.fixable },
        };
    }
}

/// Clipping needs every required item Ok. The GPU only picks speed, so it never counts.
pub fn clipping_allowed(items: &[Item]) -> bool {
    items.iter().all(|i| !i.required || i.id == ItemId::Gpu || i.state == ItemState::Ok)
}

/// Generate also needs its browser.
pub fn generate_allowed(items: &[Item]) -> bool {
    clipping_allowed(items)
        && items.iter().any(|i| i.id == ItemId::GenerateBrowser && i.state == ItemState::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Progress;

    fn items(spec: &[(ItemId, bool, ItemState)]) -> Vec<Item> {
        spec.iter().map(|(id, required, state)| Item { id: *id, required: *required, state: state.clone() }).collect()
    }

    #[test]
    fn gates_from_item_lists() {
        use ItemId::*;
        use ItemState::*;
        let miss = Missing { fixable: true };
        let table = [
            (items(&[(Ffmpeg, true, Ok), (Python, true, Ok), (Gpu, false, miss.clone())]), true, false),
            (items(&[(Ffmpeg, true, Ok), (WhisperModel, true, Fixing { percent: 40 })]), false, false),
            (items(&[(Ffmpeg, true, Ok), (GenerateBrowser, false, Ok)]), true, true),
            (items(&[(Ffmpeg, true, Ok), (GenerateBrowser, false, miss)]), true, false),
            (items(&[(Python, true, FixFailed { reason: "disk".into() })]), false, false),
            (items(&[(Gpu, true, Unknown)]), true, false),
        ];
        for (list, clipping, generate) in table {
            assert_eq!((clipping_allowed(&list), generate_allowed(&list)), (clipping, generate), "{list:?}");
        }
    }

    #[test]
    fn rows_drive_the_state_machine() {
        let row = |ok, progress: Option<u8>| ReadinessItem {
            id: "ffmpeg".into(), required: true, ok, fixable: true, detail: "no space".into(),
            progress: progress.map(|percent| Progress { percent, label: String::new() }),
        };
        let mut item = Item::new(ItemId::parse("ffmpeg"), false);
        item.checking();
        assert_eq!(item.state, ItemState::Checking);
        for (r, want) in [
            (row(false, None), ItemState::Missing { fixable: true }),
            (row(false, Some(250)), ItemState::Fixing { percent: 100 }),
            (row(false, None), ItemState::FixFailed { reason: "no space".into() }),
            (row(true, None), ItemState::Ok),
        ] {
            item.apply(&r);
            assert_eq!((&item.state, item.required), (&want, true));
        }
        assert_eq!(ItemId::parse("x"), ItemId::Other);
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// A state described by plain numbers, so a proof builds it twice without cloning.
    #[derive(Clone, Copy)]
    struct Code(u8, bool, u8);

    fn any_code() -> Code {
        Code(kani::any::<u8>() % 6, kani::any(), kani::any())
    }

    fn state(c: Code) -> ItemState {
        match c.0 {
            0 => ItemState::Unknown,
            1 => ItemState::Checking,
            2 => ItemState::Ok,
            3 => ItemState::Missing { fixable: c.1 },
            4 => ItemState::Fixing { percent: c.2 },
            _ => ItemState::FixFailed { reason: String::new() },
        }
    }

    const IDS: [ItemId; 5] = [ItemId::Ffmpeg, ItemId::Python, ItemId::WhisperModel, ItemId::Gpu, ItemId::GenerateBrowser];

    fn build(codes: [Code; 5], required: [bool; 5]) -> [Item; 5] {
        std::array::from_fn(|i| Item { id: IDS[i], required: required[i], state: state(codes[i]) })
    }

    #[kani::proof]
    #[kani::unwind(7)]
    fn gpu_never_changes_clipping() {
        let codes: [Code; 5] = std::array::from_fn(|_| any_code());
        let required: [bool; 5] = std::array::from_fn(|_| kani::any());
        let (mut codes2, mut required2) = (codes, required);
        codes2[3] = any_code();
        required2[3] = kani::any();
        assert_eq!(clipping_allowed(&build(codes, required)), clipping_allowed(&build(codes2, required2)));
    }

    #[kani::proof]
    #[kani::unwind(7)]
    fn clipping_implies_every_required_item_ok() {
        let items = build(std::array::from_fn(|_| any_code()), std::array::from_fn(|_| kani::any()));
        if clipping_allowed(&items) {
            for i in &items {
                if i.required && i.id != ItemId::Gpu {
                    assert_eq!(i.state, ItemState::Ok);
                }
            }
        }
    }
}
