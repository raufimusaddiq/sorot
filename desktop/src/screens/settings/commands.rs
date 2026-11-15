//! Settings, Generate: the custom commands a recipe may name. Each is run on a build with
//! `--project-dir` and `--version-dir` and prints its findings as JSON. A shared recipe can never
//! add one, and an install may keep them off (`allowed`).

use rune::{El, TextEdit, edit_access, row};
use serde_json::{Value, json};
use sorot_desktop_core::model::{CommandsView, GenCommand, Settings};

use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::Host;
use crate::screens::settings::generate::{GenerateSettings, save_to, test_kind};
use crate::screens::settings::{Run, hint};
use crate::ui::form::{Tone, btn, card, field, note};

pub struct Item {
    pub name: TextEdit,
    pub program: TextEdit,
    pub args: TextEdit,
    pub timeout: TextEdit,
}

impl Item {
    fn blank() -> Item {
        Item { name: TextEdit::new(""), program: TextEdit::new(""), args: TextEdit::new(""), timeout: TextEdit::new("60") }
    }

    fn of(c: &GenCommand) -> Item {
        Item { name: TextEdit::new(c.name.as_str()), program: TextEdit::new(c.cmd.as_str()), args: TextEdit::new(c.args.join(" ")), timeout: TextEdit::new(c.timeout_sec.to_string()) }
    }

    /// The command as typed; `Err` names the field that is not a number.
    fn command(&self) -> Result<GenCommand, ()> {
        let timeout_sec = self.timeout.text.trim().parse().map_err(|_| ())?;
        Ok(GenCommand { name: self.name.text.trim().into(), cmd: self.program.text.trim().into(), args: self.args.text.split_whitespace().map(String::from).collect(), timeout_sec })
    }
}

#[derive(Default)]
pub struct CommandsCard {
    pub run: Run,
    pub view: Option<CommandsView>,
    pub items: Vec<Item>,
}

impl CommandsCard {
    pub fn fill(&mut self, v: &CommandsView) {
        self.items = v.commands.iter().map(Item::of).collect();
        self.view = Some(v.clone());
    }

    /// The list as typed, or `None` when a time limit is not a number.
    fn typed(&self) -> Option<Vec<GenCommand>> {
        self.items.iter().map(|i| i.command().ok()).collect()
    }

    pub fn dirty(&self) -> bool {
        match (&self.view, self.typed()) {
            (Some(v), Some(list)) => list != v.commands,
            (Some(_), None) => true,
            _ => false,
        }
    }
}

fn run_of(g: &mut GenerateSettings) -> &mut Run {
    &mut g.commands.run
}

pub fn apply(c: &mut CommandsCard, s: &Settings) {
    if let Some(v) = &s.commands {
        c.fill(v);
    }
}

pub fn add<H: Host>(h: &mut H) {
    h.panels_mut().generate.commands.items.push(Item::blank());
}

pub fn remove<H: Host>(h: &mut H, i: usize) {
    let items = &mut h.panels_mut().generate.commands.items;
    if i < items.len() {
        items.remove(i);
    }
}

pub fn save<H: Host>(h: &mut H) {
    let bad = tr(h.lang(), "cmd.timeout-bad");
    let c = &mut h.panels_mut().generate.commands;
    let Some(list) = c.typed() else {
        c.run.error = Some(bad);
        return;
    };
    save_to(h, "commands", json!({ "commands": Value::from(list.iter().map(|x| json!(x)).collect::<Vec<_>>()) }), run_of);
}

pub fn test<H: Host>(h: &mut H) {
    test_kind(h, "commands", run_of);
}

pub fn view<H: Host>(h: &H, l: Lang, v: &CommandsView) -> El {
    let dark = h.dark();
    let c = &h.panels().generate.commands;
    let mut b = card(dark, "gen/cmd", &tr(l, "cmd.title")).child(hint(dark, tr(l, "cmd.about")));
    if !v.allowed {
        b = b.child(note(dark, "gen/cmd/off", Tone::Plain, &tr(l, "cmd.off")));
    }
    for (i, it) in c.items.iter().enumerate() {
        let k = |n: &str| format!("gen/cmd/{i}/{n}");
        let n = (i + 1).to_string();
        b = b.child(card(dark, &k("card"), &trf(l, "cmd.number", &[("n", &n)]))
            .child(field(dark, &k("name"), &tr(l, "cmd.name"), &it.name, "brand-check", false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.commands.items[i].name)))
            .child(field(dark, &k("program"), &tr(l, "cmd.program"), &it.program, "python", false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.commands.items[i].program)))
            .child(field(dark, &k("args"), &tr(l, "cmd.args"), &it.args, "check.py", false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.commands.items[i].args)))
            .child(field(dark, &k("timeout"), &tr(l, "cmd.timeout"), &it.timeout, "60", false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.commands.items[i].timeout)))
            .child(btn(dark, k("remove"), &trf(l, "cmd.remove", &[("n", &n)]), false, v.allowed && !c.run.busy, move |h: &mut H| remove(h, i))));
    }
    b = b.child(row().gap(10.0)
        .child(btn(dark, "gen/cmd/add", &tr(l, "cmd.add"), false, v.allowed && !c.run.busy, add::<H>))
        .child(btn(dark, "gen/cmd/save", &tr(l, "conn.save"), true, v.allowed && !c.run.busy && c.dirty(), save::<H>))
        .child(btn(dark, "gen/cmd/test", &tr(l, "conn.test"), false, !c.run.busy, test::<H>)));
    for n in c.run.notes(dark, l, "gen/cmd") {
        b = b.child(n);
    }
    b
}
