//! The two catalogs stay in step: the same keys, and no em dash in any value (R-02).

type Catalog = std::collections::HashMap<String, String>;

fn catalog(include: &'static str) -> Catalog {
    serde_json::from_str(include).expect("the i18n file is a flat string map")
}

#[test]
fn both_languages_hold_the_same_keys_without_em_dashes() {
    let id = catalog(include_str!("../i18n/id.json"));
    let en = catalog(include_str!("../i18n/en.json"));
    assert_eq!(id.keys().collect::<std::collections::BTreeSet<_>>(), en.keys().collect::<std::collections::BTreeSet<_>>());
    assert!(id.values().chain(en.values()).all(|v| !v.contains('\u{2014}')), "an em dash is forbidden in UI text");
}
