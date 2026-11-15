//! Generate: briefs to 2D videos, laid out as the design frames show (`design/frames/generate-*`):
//! the project list beside its seven steps, then one page per step under a step tab row, and the
//! recipes, kit and version history pages. Without an AI connection the whole window is one
//! "Generate needs an AI connection" block (constitution IV); clipping never looks here.

pub mod brief;
pub mod build;
pub mod facts;
pub mod ideas;
pub mod kit;
pub mod plan;
pub mod recipes;
pub mod storylines;
pub mod words;
pub mod verdict;
pub mod versions;

use rune::tok::type_;
use rune::{El, ScrollSpec, col, row, text};
use sorot_desktop_core::availability::{Connections, Link, generate_available};
use sorot_desktop_core::model::Settings;
use sorot_desktop_core::readiness::{Item, ItemId};

use crate::engine::generate as api;
use crate::engine::generate::{Built, Detail, Estimate, Fact, Project};
use crate::engine::{Engine, EngineError};
use crate::screens::panels::{Host, Load, Page, Panels, answer, go};
use crate::ui::form::{Tone, btn, card, choice, heading, note};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};
use words::{t, tf};

/// The seven steps of a video, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Brief,
    Ideas,
    Facts,
    Stories,
    Plan,
    Build,
    Verdict,
}

pub const STEPS: [(Step, &str); 7] = [
    (Step::Brief, "brief"), (Step::Ideas, "ideas"), (Step::Facts, "facts"), (Step::Stories, "stories"), (Step::Plan, "plan"), (Step::Build, "build"), (Step::Verdict, "verdict"),
];

/// The pages of the window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Home,
    Step(Step),
    Recipes,
    Kit,
    Versions,
}

/// Whether Generate can run here, from `core::availability`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Avail {
    Yes { compute: String },
    /// Why not, in the engine's words.
    No { reasons: Vec<String> },
}

/// Everything one read of a video brings.
pub struct Loaded {
    pub detail: Detail,
    pub estimate: Option<Estimate>,
    pub built: Option<Built>,
    /// The facts, when the recipe has a facts step.
    pub facts: Option<Vec<Fact>>,
}

#[derive(Default)]
pub struct Studio {
    pub load: Load,
    pub avail: Option<Avail>,
    pub view: View,
    pub projects: Vec<Project>,
    /// `None` is the brief form for a new video.
    pub selected: Option<String>,
    pub detail: Option<Detail>,
    pub estimate: Option<Estimate>,
    /// The version whose verdicts show; `None` is the newest.
    pub shown: Option<String>,
    pub built: Option<Built>,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub brief: brief::Form,
    pub stories: storylines::Note,
    pub plan: plan::Draft,
    pub build: build::Panel,
    pub facts: facts::Facts,
    pub ideas: ideas::Ideas,
    pub recipes: recipes::Recipes,
    pub kit: kit::Kit,
}

impl Studio {
    /// The open video is at work (the director or a build): the app looks again until it stops.
    pub fn working(&self) -> bool {
        self.detail.as_ref().is_some_and(|d| d.project.working() || d.versions.first().is_some_and(|v| v.working()))
    }

    /// A read of the open video lands here.
    fn take(&mut self, l: Loaded) {
        if let Some(p) = self.projects.iter_mut().find(|p| p.id == l.detail.project.id) {
            *p = l.detail.project.clone();
        }
        if let Some(row) = l.detail.current_plan() {
            self.plan.sync(row);
        }
        if let Some(list) = l.facts {
            (self.facts.list, self.facts.load) = (list, Load::Ready);
        }
        (self.detail, self.estimate, self.built) = (Some(l.detail), l.estimate, l.built);
    }
}

/// How one step of the open video stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stand {
    Done,
    /// Waiting for the owner: a pick, an approval.
    Waiting(&'static str),
    Working,
    Failed,
    Idle,
    Skipped,
}

impl Stand {
    pub fn word(self) -> String {
        t(match self {
            Stand::Done => "state.done",
            Stand::Waiting(key) => key,
            Stand::Working => "state.working",
            Stand::Failed => "state.failed",
            Stand::Idle => "state.idle",
            Stand::Skipped => "state.skipped",
        })
    }
}

/// Where `step` stands for `d`.
pub fn stand(d: &Detail, step: Step) -> Stand {
    let p = &d.project;
    let version = d.versions.first();
    let accepted = matches!(p.status.as_str(), "ACCEPTED" | "EXPORTED");
    match step {
        Step::Brief | Step::Ideas => Stand::Done,
        Step::Facts if !p.has_facts() => Stand::Skipped,
        Step::Facts => Stand::Done,
        Step::Stories if !d.plans.is_empty() => Stand::Done,
        Step::Stories if p.status == "FAILED" => Stand::Failed,
        Step::Stories if p.storylines.is_some() && !p.working() => Stand::Waiting("state.pick"),
        Step::Stories => Stand::Working,
        Step::Plan if d.plans.is_empty() => Stand::Idle,
        Step::Plan if d.approved() => Stand::Done,
        Step::Plan if p.status == "RUNNING" => Stand::Working,
        Step::Plan => Stand::Waiting("state.waiting"),
        Step::Build => match version {
            None => Stand::Idle,
            Some(v) if v.working() => Stand::Working,
            Some(v) if v.status == "FAILED" => Stand::Failed,
            Some(v) if v.status == "BUILT" => Stand::Done,
            Some(_) => Stand::Idle,
        },
        Step::Verdict if accepted => Stand::Done,
        Step::Verdict if version.is_some_and(|v| v.status == "BUILT") => Stand::Waiting("state.review"),
        Step::Verdict => Stand::Idle,
    }
}

/// Reads one video: its detail, the build estimate while one can start, the two verdicts of the
/// version on screen, and its facts.
pub fn read(e: &dyn Engine, id: &str, shown: Option<&str>) -> Result<Loaded, EngineError> {
    let detail = api::project(e, id)?;
    let estimate = if detail.approved() && !detail.project.working() { api::estimate(e, id).ok() } else { None };
    let newest = shown.and_then(|s| detail.versions.iter().find(|v| v.id == s)).or(detail.versions.first());
    let built = match newest.filter(|v| v.status == "BUILT") {
        Some(v) => Some(api::version(e, &v.id)?),
        None => None,
    };
    let facts = if detail.project.has_facts() { Some(api::facts(e, id)?) } else { None };
    Ok(Loaded { detail, estimate, built, facts })
}

fn gate(e: &dyn Engine) -> Result<Avail, EngineError> {
    let settings: Settings = e.settings()?;
    let status = e.generate_status()?;
    let items: Vec<Item> = e
        .readiness()?
        .items
        .iter()
        .map(|row| {
            let mut item = Item::new(ItemId::parse(&row.id), row.required);
            item.apply(row);
            item
        })
        .collect();
    let link = |c: &sorot_desktop_core::model::Connection| Link { configured: c.api_key_set || c.active, healthy: c.active };
    let ok = generate_available(&Connections { llm: link(&settings.llm), jev: link(&settings.jev) }, &items);
    Ok(if ok { Avail::Yes { compute: status.compute } } else { Avail::No { reasons: status.reasons } })
}

/// Opens the window: availability first; when Generate can run, the videos and the first one.
pub fn open<H: Host>(h: &mut H) {
    h.panels_mut().studio.load = Load::Loading;
    go(h, |e| {
        let r = gate(e).and_then(|avail| match avail {
            Avail::Yes { .. } => {
                let projects = api::projects(e)?;
                let first = match projects.first() {
                    Some(p) => Some(read(e, &p.id, None)?),
                    None => None,
                };
                Ok((avail, projects, first))
            }
            no => Ok((no, vec![], None)),
        });
        answer(r, |p, r| {
            let s = &mut p.studio;
            s.load = Load::of(&r);
            if let Ok((avail, projects, first)) = r {
                (s.avail, s.projects, s.selected, s.shown, s.error, s.view) = (Some(avail), projects, first.as_ref().map(|l| l.detail.project.id.clone()), None, None, View::Home);
                if let Some(l) = first {
                    s.take(l);
                }
            }
        })
    });
}

/// Opens one video (its steps), or the brief form for a new one (`None`).
pub fn select<H: Host>(h: &mut H, id: Option<String>) {
    let s = &mut h.panels_mut().studio;
    (s.selected, s.detail, s.estimate, s.built, s.shown, s.error, s.notice) = (id.clone(), None, None, None, None, None, None);
    s.view = if id.is_some() { View::Home } else { View::Step(Step::Brief) };
    if let Some(id) = id {
        go(h, move |e| answer(read(e, &id, None), finish));
    }
}

fn finish(p: &mut Panels, r: Result<Loaded, String>) {
    p.studio.busy = false;
    match r {
        Ok(l) => p.studio.take(l),
        Err(why) => p.studio.error = Some(why),
    }
}

/// One action on the open video, then a fresh read of it. The action's `Some(words)` is a notice.
pub fn act<H: Host>(h: &mut H, f: impl FnOnce(&dyn Engine, &str) -> Result<Option<String>, EngineError> + Send + 'static) {
    let s = &mut h.panels_mut().studio;
    let (Some(id), shown) = (s.selected.clone(), s.shown.clone()) else { return };
    (s.busy, s.error, s.notice) = (true, None, None);
    go(h, move |e| {
        let r = f(e, &id).and_then(|notice| Ok((notice, read(e, &id, shown.as_deref())?)));
        answer(r, |p, r| match r {
            Ok((notice, l)) => {
                p.studio.notice = notice;
                finish(p, Ok(l));
            }
            Err(why) => finish(p, Err(why)),
        })
    });
}

/// Looks at the open video again while it works.
pub fn poll<H: Host>(h: &mut H) {
    let s = &h.panels().studio;
    let (Some(id), shown) = (s.selected.clone(), s.shown.clone()) else { return };
    go(h, move |e| answer(read(e, &id, shown.as_deref()), |p, r| if let Ok(l) = r { p.studio.take(l) }));
}

/// Takes the list and one opened video after something made or resumed a video.
pub fn opened(p: &mut Panels, r: Result<(Vec<Project>, Loaded), String>) {
    let s = &mut p.studio;
    s.busy = false;
    match r {
        Ok((list, l)) => {
            (s.projects, s.selected, s.view, s.shown) = (list, Some(l.detail.project.id.clone()), View::Home, None);
            s.take(l);
        }
        Err(why) => s.error = Some(why),
    }
}

/// The list again and one video opened, for the engine to have just made or resumed it.
pub fn open_one(e: &dyn Engine, id: &str) -> Result<(Vec<Project>, Loaded), EngineError> {
    Ok((api::projects(e)?, read(e, id, None)?))
}

fn open_settings<H: Host>(h: &mut H) {
    h.show(Page::Connections);
}

/// Goes to a page; the ones that list something read their list.
pub fn go_view<H: Host>(h: &mut H, view: View) {
    h.panels_mut().studio.view = view;
    match view {
        View::Step(Step::Ideas) => ideas::load(h),
        View::Step(Step::Build) => build::load_log(h),
        View::Recipes => recipes::load(h),
        View::Kit => kit::load(h),
        _ => {}
    }
}

fn delete<H: Host>(h: &mut H) {
    let Some(id) = h.panels().studio.selected.clone() else { return };
    let s = &mut h.panels_mut().studio;
    (s.busy, s.error) = (true, None);
    go(h, move |e| {
        let r = api::delete_project(e, &id).and_then(|()| api::projects(e));
        answer(r, |p, r| {
            let s = &mut p.studio;
            s.busy = false;
            match r {
                Ok(list) => (s.projects, s.selected, s.detail, s.built, s.estimate, s.view) = (list, None, None, None, None, View::Home),
                Err(why) => s.error = Some(why),
            }
        })
    });
}

fn retry<H: Host>(h: &mut H) {
    act(h, |e, id| api::retry_project(e, id).map(|()| None));
}

/// The three places beside the steps: projects, recipes, kit.
fn nav<H: Host>(dark: bool, on: View) -> El {
    let item = |key: &str, label: &str, view: View, chosen: bool| choice(dark, key, label, chosen, move |h: &mut H| go_view(h, view));
    row().gap(8.0)
        .child(item("generate/nav/projects", &t("nav.projects"), View::Home, !matches!(on, View::Recipes | View::Kit)))
        .child(item("generate/nav/recipes", &t("nav.recipes"), View::Recipes, on == View::Recipes))
        .child(item("generate/nav/kit", &t("nav.kit"), View::Kit, on == View::Kit))
}

/// The tab row of a step page.
fn step_tabs<H: Host>(dark: bool, on: Step) -> El {
    let mut r = row().gap(8.0);
    for (step, key) in STEPS {
        r = r.child(choice(dark, &format!("generate/steptab/{key}"), &t(&format!("step.{key}")), on == step, move |h: &mut H| go_view(h, View::Step(step))));
    }
    r
}

/// The project list and the seven steps of the open one.
fn home<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let mut list = card(dark, "generate/projects", &t("projects.title"));
    for proj in &s.projects {
        let id = proj.id.clone();
        list = list.child(choice(dark, &format!("generate/video/{}", proj.id), &proj.name(), s.selected.as_deref() == Some(&proj.id), move |h: &mut H| select(h, Some(id.clone()))));
    }
    list = list.child(btn(dark, "generate/new", &t("projects.new"), false, true, |h: &mut H| select(h, None)));
    let mut steps = card(dark, "generate/steps", &t("steps.title"));
    match &s.detail {
        Some(d) => {
            if STEPS.iter().any(|(st, _)| matches!(stand(d, *st), Stand::Waiting(_))) {
                steps = steps.child(text(t("steps.waiting")).key("generate/steps/hint").font(type_::LABEL).color(p.muted));
            }
            for (i, (step, key)) in STEPS.iter().enumerate() {
                let st = stand(d, *step);
                let name = t(&format!("step.{key}"));
                let step = *step;
                let ink = if matches!(st, Stand::Waiting(_)) { p.beam_text } else if st == Stand::Failed { p.skip } else { p.muted };
                steps = steps.child(
                    row().key(format!("generate/step/{key}")).role("button").label(format!("{name}: {}", st.word())).focusable(true).gap(12.0).items_center().w_full().padding(10.0)
                        .on_press(move |h: &mut H| go_view(h, View::Step(step)))
                        .child(text((i + 1).to_string()).font(type_::LABEL).color(p.muted))
                        .child(text(name).font(type_::TITLE).color(p.text).grow(1.0))
                        .child(text(st.word()).key(format!("generate/step/{key}/state")).font(type_::LABEL).color(ink)),
                );
            }
        }
        None if s.selected.is_some() && s.error.is_none() => steps = steps.child(state_block::<H>(dark, "generate/loading", Kind::Loading, &t("steps.loading.cause"), &t("steps.loading.next"), None)),
        None => steps = steps.child(text(t("steps.none")).key("generate/steps/none").font(type_::BODY).color(p.muted).wrap()),
    }
    row().gap(20.0).w_full().child(col().w(320.0).child(list)).child(col().grow(1.0).child(steps))
}

/// What a video's problem or progress says, above its step pages.
fn project_notes<H: Host>(dark: bool, s: &Studio) -> El {
    let mut c = col().gap(8.0).w_full();
    let Some(d) = &s.detail else { return c };
    let proj = &d.project;
    if proj.status == "RUNNING" {
        let key = if !d.plans.is_empty() { "project.working" } else if proj.storylines.is_some() { "project.plan_from" } else { "project.stories" };
        c = c.child(note(dark, "generate/working", Tone::Plain, &t(key)));
    }
    if proj.status == "FAILED" {
        let why = proj.error_message.clone().unwrap_or_else(|| t("project.no_reason"));
        c = c.child(note(dark, "generate/failed", Tone::Bad, &tf("project.failed", &[&why]))).child(btn(dark, "generate/retry", &t("retry"), false, !s.busy, retry::<H>));
    }
    c
}

/// One step's page: its heading and tab row, then its body.
fn step_page<H: Host>(dark: bool, s: &Studio, step: Step) -> El {
    let key = STEPS.iter().find(|(st, _)| *st == step).map(|(_, k)| *k).unwrap_or("brief");
    let mut c = col().gap(16.0).w_full()
        .child(heading(dark, &format!("generate/{key}/title"), &t(&format!("step.{key}")), &t(&format!("step.{key}.sub"))))
        .child(step_tabs::<H>(dark, step))
        .child(project_notes::<H>(dark, s));
    let body = match (step, &s.detail) {
        (Step::Brief, _) => brief::view::<H>(dark, s),
        (Step::Ideas, _) => ideas::view::<H>(dark, s),
        (_, None) => state_block::<H>(dark, "generate/no-project", Kind::Empty, &t("steps.none"), "", None),
        (Step::Facts, Some(d)) => facts::view::<H>(dark, s, d.project.working()),
        (Step::Stories, Some(d)) => storylines::view::<H>(dark, s, d),
        (Step::Plan, Some(d)) => plan::view::<H>(dark, s, d),
        (Step::Build, Some(d)) => build::view::<H>(dark, s, d),
        (Step::Verdict, Some(d)) => verdict::view::<H>(dark, s, d),
    };
    c = c.child(body);
    if let Some(d) = &s.detail {
        if matches!(step, Step::Build | Step::Verdict) && d.versions.len() > 1 {
            c = c.child(btn(dark, "generate/versions/open", &t("build.versions"), false, true, |h: &mut H| go_view(h, View::Versions)));
        }
        if step == Step::Build {
            c = c.child(btn(dark, "generate/delete", &t("project.delete"), false, !s.busy && !d.project.working(), delete::<H>));
        }
    }
    c
}

/// A button under a block: key, label, handler.
type Way<H> = (&'static str, String, fn(&mut H));

/// An error block with its way out, as one column.
fn blocked<H: Host>(dark: bool, key: &str, kind: Kind, cause: &str, next: &str, action: Option<Way<H>>) -> El {
    let mut c = col().gap(12.0).items_center().child(state_block::<H>(dark, key, kind, cause, next, None));
    if let Some((k, label, on_press)) = action {
        c = c.child(btn(dark, k, &label, true, true, on_press));
    }
    c
}

/// The window. `Studio::avail` decides: unavailable is one block with the way out.
pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let s = &h.panels().studio;
    let body = match (&s.load, &s.avail) {
        (Load::Failed(why), _) => blocked::<H>(dark, "generate/load-failed", Kind::Error, &t("failed.cause"), &tf("failed.next", &[why]), Some(("generate/retry-open", t("retry"), open::<H>))),
        (_, Some(Avail::No { reasons })) => {
            let next = tf("unavailable.next", &[&reasons.join(" ")]);
            blocked::<H>(dark, "generate/unavailable", Kind::Empty, &t("unavailable.cause"), next.trim(), Some(("generate/open-settings", t("unavailable.open"), open_settings::<H>)))
        }
        (_, Some(Avail::Yes { compute })) => {
            let mut c = col().gap(16.0).w_full();
            if let Some(why) = &s.error {
                c = c.child(note(dark, "generate/error", Tone::Bad, why));
            }
            if let Some(done) = &s.notice {
                c = c.child(note(dark, "generate/notice", Tone::Ok, done));
            }
            let page = match s.view {
                View::Home => col().gap(16.0).w_full()
                    .child(heading(dark, "generate/title", &t("title"), &t("sub")))
                    .child(nav::<H>(dark, s.view))
                    .child(text(tf("ready", &[&compute.to_uppercase()])).key("generate/ready").font(type_::LABEL).color(pal(dark).muted))
                    .child(home::<H>(dark, s)),
                View::Step(step) => step_page::<H>(dark, s, step),
                View::Recipes => col().gap(16.0).w_full().child(nav::<H>(dark, s.view)).child(recipes::view::<H>(dark, s)),
                View::Kit => col().gap(16.0).w_full().child(nav::<H>(dark, s.view)).child(kit::view::<H>(dark, s)),
                View::Versions => versions::view::<H>(dark, s),
            };
            c.child(page)
        }
        _ => state_block::<H>(dark, "generate/opening", Kind::Loading, &t("opening.cause"), &t("opening.next"), None),
    };
    col().key("generate/scroll").scroll(ScrollSpec { stick_bottom: false }).gap(20.0).padding(40.0).w_full().h_full().max_w(1100.0).child(body)
}
