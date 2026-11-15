//! L2: the rail and the Settings tabs open the panel screens inside the real app state.


use sorot_desktop::app::Route;
use crate::support::*;

#[test]
fn the_rail_and_tabs_open_each_panel_screen_and_read_the_engine() {
    let rows = [
        ("shell/rail/discover", Route::Discover, "discover/find"),
        ("shell/rail/learning", Route::Learning, "learning/title"),
        ("shell/rail/settings", Route::Connections, "conn/title"),
        ("settings/tab/generate", Route::GenerateSettings, "gen/failed"),
        ("settings/tab/connections", Route::Connections, "conn/title"),
    ];
    let mut rt = runtime("connections");
    for (key, route, shows) in rows {
        click(&mut rt, key);
        assert_eq!(rt.state.route, route, "{key}");
        assert!(rt.find(shows).is_some(), "{key} -> {shows}");
    }
    rt.update(|s, _| s.open_publish("c1", "T"));
    rt.frame(0.0);
    assert!(rt.find("publish/title").is_some());
}
