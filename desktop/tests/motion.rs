//! Rune's motion gate over the job and clips screens, on its virtual clock: the beam moves only when
//! the engine reports, a finished stage rings once, selecting and re-ranking clips settle without
//! snapping, flashing or changing twice.


use rune::motion_gate::{self, AllowRow, Job, Run};
use rune::{Env, Runtime};
use sorot_desktop::app::{Msg, SCENES, State};
use sorot_desktop::engine::Engine;
use sorot_desktop::engine::fake::FakeEngine;

const ALLOW: &[AllowRow] = &[
    AllowRow::new("text-swap", "job/stage-name", "job/stage-done", "the stage name changes the moment the engine names the next stage"),
    AllowRow::new("text-swap", "job/elapsed", "job/stage-done", "the line under the name says what the new stage does"),
    AllowRow::new("text-swap", "job/notes/", "job/stage-done", "a finished stage's note replaces its running report"),
    AllowRow::new("text-swap", "stage/", "job/stage-done", "a stage's mark and word change with its state; the ring and the beam carry the motion"),
];

fn start(name: &str) -> Run<State> {
    let mut state = State::default();
    SCENES.iter().find(|(n, _)| *n == name).unwrap().1(&mut state);
    let mut r = Run::new(Runtime::new(state, sorot_desktop::app::view, (1100.0, 720.0), Env::new(true, 1.0)), 120.0);
    r.idle(1.0);
    r.step();
    r
}

fn job_progress() -> motion_gate::Recording {
    let mut detail = FakeEngine::scene("job-running").job("j1").unwrap();
    let mut r = start("job-running");
    detail.stages[4].output_path = Some("Scoring 80%".into());
    r.act("progress to 80%", move |rt| {
        rt.update(move |s, _| {
            s.tick(2.0);
            s.apply(Msg::JobDetail(detail));
        })
    });
    r.play(1.0);
    r.rec
}

fn job_stage_done() -> motion_gate::Recording {
    let mut detail = FakeEngine::scene("job-running").job("j1").unwrap();
    let mut r = start("job-running");
    (detail.stages[4].status, detail.stages[5].status) = ("COMPLETED".into(), "IN_PROGRESS".into());
    r.act("stage 4 done", move |rt| {
        rt.update(move |s, _| {
            s.tick(2.0);
            s.apply(Msg::JobDetail(detail));
        })
    });
    r.play(1.0);
    r.rec
}

fn clips_select() -> motion_gate::Recording {
    let mut r = start("clips-ranked");
    r.act("tap the second clip", |rt| Run::tap(rt, "clips/row/c1"));
    r.play(1.0);
    r.rec
}

fn clips_rerank() -> motion_gate::Recording {
    let mut clips = FakeEngine::scene("clips-ranked").clips("vnew").unwrap();
    let mut r = start("clips-ranked");
    (clips[0].rank_pos, clips[1].rank_pos) = (Some(2), Some(1));
    r.act("two clips swap rank", move |rt| {
        rt.update(move |s, _| s.apply(Msg::Clips { video_id: "vnew".into(), clips }))
    });
    r.play(1.0);
    r.rec
}

#[test]
fn motion_gate() {
    let cells: Vec<(String, Job)> = vec![
        ("job/progress".into(), Box::new(job_progress) as Job),
        ("job/stage-done".into(), Box::new(job_stage_done) as Job),
        ("clips/select".into(), Box::new(clips_select) as Job),
        ("clips/rerank".into(), Box::new(clips_rerank) as Job),
    ];
    motion_gate::gate_rows(cells, ALLOW);
}
