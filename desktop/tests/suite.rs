//! The one integration-test binary: each file is a module, so Rune links once, not fourteen times.
//! `cargo test --test suite <filter>` runs one (`a11y::`, `snapshots::`, ...).

mod support;

mod a11y;
mod app_screens;
mod design_rules;
mod general_screen;
mod generate_screens;
mod headless_flows;
mod headless_run;
mod motion;
mod os_proc;
mod panel_nav;
mod panel_screens;
mod platform_list;
mod snapshots;
mod us1_screens;
mod us2_screens;
mod us3_screens;
