//! L2 for US4: the command palette and the menu bar's system pop-ups, in process on `FakeEngine`.

use sorot_desktop::app::Screen;

use crate::support::*;

/// The app's own key handler (`AppSpec::on_key`) sees Ctrl+K; a bare `Runtime` has none, so the test calls it.
fn ctrl_k(rt: &mut rune::Runtime<sorot_desktop::app::State>) {
    rt.update(|s, tx| {
        s.keys(&rune::KeyEvent { key: rune::Key::Command('k'), mods: rune::Mods { cmd: true, ..rune::Mods::default() } }, tx);
    });
    rt.frame(1.0 / 60.0);
}

fn focused(rt: &rune::Runtime<sorot_desktop::app::State>) -> Option<String> {
    rt.elements().into_iter().find(|e| e.focused).and_then(|e| e.key)
}

/// Ctrl+K opens the palette on its field, typing narrows the list to what `palette_search` ranks, Enter runs the first
/// row and closes it, and Escape closes it with focus back where it was.
#[test]
fn the_palette_opens_filters_runs_and_gives_focus_back() {
    let mut rt = scene_rt("clips-ranked");
    assert!(rt.find("palette").is_none());
    press(&mut rt, "Tab");
    let before = focused(&rt);
    assert!(before.is_some());

    ctrl_k(&mut rt);
    assert_eq!(focused(&rt).as_deref(), Some("palette/input"));
    let all = rt.elements().iter().filter(|e| e.role == "option").count();
    let keys: Vec<String> = rt.elements().iter().filter(|e| e.role == "option").filter_map(|e| e.key.as_deref()?.strip_prefix("palette/item/").map(String::from)).collect();
    let want: Vec<String> = sorot_desktop::screens::menu_bar::actions(&rt.state).iter().map(|a| a.0.to_string()).collect();
    assert_eq!((keys, all), (want, 13), "every action of the menus is listed");

    press(&mut rt, "Escape");
    assert!(rt.find("palette").is_none());
    assert_eq!(focused(&rt), before, "Escape returns focus");

    ctrl_k(&mut rt);
    rt.key(rune::KeyEvent { key: rune::Key::Text("SETÈL".into()), mods: rune::Mods::default() });
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.elements().iter().filter(|e| e.role == "option").filter_map(|e| e.key.clone()).collect::<Vec<_>>(), ["palette/item/settings"], "accents and case are ignored");
    press(&mut rt, "Enter");
    assert!(rt.find("palette").is_none());
    assert_eq!(rt.state.screen(), Screen::Connections);
}

/// The palette is glass surface 1 of 2: one palette slot over the screen, two glass slots in all with the transport behind it.
#[test]
fn the_open_palette_is_one_glass_surface_of_two() {
    let rt = scene_rt("palette-open");
    let glass: Vec<_> = slots(&rt).into_iter().map(|(m, _)| m).filter(|m| m.is_glass()).collect();
    assert_eq!(glass.iter().filter(|m| **m == sorot_desktop::ui::fx_moments::Moment::PaletteGlass).count(), 1);
    assert_eq!(glass.len(), 2);
}

/// The arrows move the highlight (and wrap), a press on a row runs it, and a query nothing matches says so.
#[test]
fn the_palette_arrows_wrap_and_a_press_runs_a_row() {
    let mut rt = scene_rt("clips-ranked");
    ctrl_k(&mut rt);
    let at = |rt: &rune::Runtime<sorot_desktop::app::State>| {
        let n = rt.state.palette_hits().len();
        (n, rt.state.palette_row(n))
    };
    let (n, first) = at(&rt);
    assert_eq!(first, 0);
    press(&mut rt, "Up");
    assert_eq!(at(&rt).1, n - 1, "Up from the first row wraps to the last");
    press(&mut rt, "Down");
    assert_eq!(at(&rt).1, 0);

    rt.key(rune::KeyEvent { key: rune::Key::Text("zzzz".into()), mods: rune::Mods::default() });
    rt.frame(1.0 / 60.0);
    assert!(rt.find("palette/empty").is_some());
    press(&mut rt, "Enter");
    assert!(rt.find("palette").is_some(), "Enter on no row does nothing");

    poke(&mut rt, |s| s.palette.query = rune::TextEdit::new(""));
    click(&mut rt, "palette/item/discover");
    assert_eq!(rt.state.screen(), Screen::Discover);
    assert!(rt.find("palette").is_none());
}

/// The rail, the View menu, the palette and the macOS system menu offer the same destinations.
#[test]
fn the_rail_the_menu_the_palette_and_the_system_menu_list_the_same_destinations() {
    let mut state = sorot_desktop::app::State::scene("clips-ranked");
    state.show_clips("vnew");
    let rt = runtime_of(state);
    let rail: Vec<String> = rt.elements().iter().filter_map(|e| e.key.as_deref()?.strip_prefix("shell/rail/").map(String::from)).collect();
    assert_eq!(rail, ["home", "clips", "discover", "generate", "learning", "settings"]);
    let menu = |m| sorot_desktop::screens::menu_bar::menu_items(&rt.state, m).into_iter().map(|(k, ..)| k.to_string()).filter(|k| k != "theme").collect::<Vec<_>>();
    assert_eq!(menu(sorot_desktop::screens::menu_bar::Menu::View), rail, "the View menu");
    let palette: Vec<String> = rt.state.palette_hits().into_iter().map(|h| h.0.to_string()).collect();
    assert!(rail.iter().all(|k| palette.contains(k)), "the palette");
    let system: Vec<String> = sorot_desktop::screens::menu_bar::native_entries(sorot_desktop::i18n::Lang::En).into_iter().map(|e| e.0).collect();
    assert!(rail.iter().all(|k| system.contains(&format!("view/{k}"))), "the system menu: {system:?}");
}

/// Where the system draws pop-up menus (Windows, macOS, every headless run) a menu of the bar opens as one and a pick runs
/// the item; on Linux the in-window list (`the_menus_open_run_and_close`) stands in.
#[test]
fn a_menu_of_the_bar_opens_as_a_system_pop_up_and_a_pick_runs_the_item() {
    let mut state = sorot_desktop::app::State::scene("clips-ranked");
    state.native_popups = true;
    let mut rt = runtime_of(state);
    click(&mut rt, "shell/menu/view");
    assert!(rt.find("shell/menu-list").is_none(), "no in-window list beside the pop-up");
    assert!(rt.popup_menu().expect("the menu opened").find("settings").is_some());
    rt.resolve_popup(Some("settings")).unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.screen(), Screen::Connections);
    click(&mut rt, "shell/menu/view");
    rt.resolve_popup(None).unwrap();
    assert_eq!(rt.state.screen(), Screen::Connections, "dismissing a menu runs nothing");
}
