//! Linux preview: one ffmpeg decodes pictures, another `s16le` sound; the sound device's clock
//! decides which picture is on screen (`core::av_clock`). Every process and audio call goes
//! through `Launcher`, `Pipe`, `AudioOut` and `FrameSink`, so the logic runs without any of them.

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};

use rune::El;
use sorot_desktop_core::av_clock::{pick_frame, seek_restart};

use super::{Preview, PreviewState};

pub const WIDTH: u32 = 360;
pub const HEIGHT: u32 = 640;
pub const FPS: i64 = 30;
pub const SAMPLE_RATE: u32 = 44_100;
pub const FRAME_BYTES: usize = (WIDTH * HEIGHT * 4) as usize;
/// Decoded pictures held ahead of the sound; past this the reader waits.
const AHEAD: usize = 45;

/// What a process pipe has for the player right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Chunk {
    Data(Vec<u8>),
    Idle,
    Ended(i32),
}

pub trait Pipe: Send {
    fn next(&mut self) -> Chunk;
    fn kill(&mut self);
}

pub trait Launcher: Send + Sync {
    fn spawn(&self, args: Vec<String>) -> io::Result<Box<dyn Pipe>>;
}

pub trait AudioOut: Send {
    fn write(&mut self, pcm: &[u8]);
    /// Milliseconds of sound played since the last `clear`.
    fn played_ms(&self) -> i64;
    fn set_paused(&mut self, paused: bool);
    fn clear(&mut self);
    fn set_muted(&mut self, muted: bool);
}

pub trait FrameSink: Send {
    fn show(&mut self, bgra: Vec<u8>, id: u64);
    fn paint(&self, stage: El) -> El;
}

fn input(path: &Path, from: &str) -> Vec<String> {
    ["-v", "error", "-ss", from, "-i"].iter().map(|s| s.to_string()).chain([path.to_string_lossy().into_owned()]).collect()
}

/// ffmpeg arguments: BGRA pictures (what Rune's surface takes) at `WIDTH`x`HEIGHT`, from `from` seconds.
pub fn video_args(path: &Path, from: &str) -> Vec<String> {
    let scale = format!("scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps={FPS}");
    input(path, from).into_iter().chain(["-an", "-vf", &scale, "-pix_fmt", "bgra", "-f", "rawvideo", "-"].map(String::from)).collect()
}

pub fn audio_args(path: &Path, from: &str) -> Vec<String> {
    let rate = SAMPLE_RATE.to_string();
    input(path, from).into_iter().chain(["-vn", "-ac", "2", "-ar", &rate, "-f", "s16le", "-"].map(String::from)).collect()
}

pub struct FfmpegPlayer<L, A, S> {
    launcher: L,
    audio: A,
    sink: S,
    path: Option<PathBuf>,
    duration: Option<f64>,
    /// Where the running (or paused) stretch starts, in ms.
    base_ms: i64,
    video: Option<Box<dyn Pipe>>,
    sound: Option<Box<dyn Pipe>>,
    pending: Vec<u8>,
    frames: VecDeque<(i64, Vec<u8>)>,
    made: i64,
    video_exit: Option<i32>,
    state: PreviewState,
    shown: u64,
}

impl<L: Launcher, A: AudioOut, S: FrameSink> FfmpegPlayer<L, A, S> {
    pub fn new(launcher: L, audio: A, sink: S) -> Self {
        FfmpegPlayer {
            launcher, audio, sink, path: None, duration: None, base_ms: 0, video: None, sound: None, pending: vec![],
            frames: VecDeque::new(), made: 0, video_exit: None, state: PreviewState::Idle, shown: 0,
        }
    }

    fn stop(&mut self) {
        for mut p in [self.video.take(), self.sound.take()].into_iter().flatten() {
            p.kill();
        }
        (self.pending, self.frames, self.made, self.video_exit) = (vec![], VecDeque::new(), 0, None);
        self.audio.clear();
    }

    /// Starts both decoders at `base_ms`.
    fn start(&mut self) {
        let Some(path) = self.path.clone() else { return };
        self.stop();
        let from = seek_restart(self.base_ms);
        match (self.launcher.spawn(video_args(&path, &from)), self.launcher.spawn(audio_args(&path, &from))) {
            (Ok(v), Ok(a)) => {
                (self.video, self.sound) = (Some(v), Some(a));
                self.audio.set_paused(false);
                self.state = PreviewState::Playing;
            }
            (v, a) => {
                let why = v.err().or(a.err()).map(|e| e.to_string()).unwrap_or_default();
                self.state = PreviewState::Error(format!("ffmpeg could not start: {why}"));
            }
        }
    }

    fn take_frames(&mut self) {
        while self.frames.len() < AHEAD && self.video_exit.is_none() {
            match self.video.as_mut().map_or(Chunk::Idle, |p| p.next()) {
                Chunk::Data(bytes) => {
                    self.pending.extend(bytes);
                    while self.pending.len() >= FRAME_BYTES {
                        let frame: Vec<u8> = self.pending.drain(..FRAME_BYTES).collect();
                        self.frames.push_back((self.base_ms + self.made * 1000 / FPS, frame));
                        self.made += 1;
                    }
                }
                Chunk::Idle => break,
                Chunk::Ended(code) => self.video_exit = Some(code),
            }
        }
    }

    fn take_sound(&mut self) {
        while let Some(Chunk::Data(pcm)) = self.sound.as_mut().map(|p| p.next()) {
            self.audio.write(&pcm);
        }
    }
}

impl<L: Launcher, A: AudioOut, S: FrameSink> Preview for FfmpegPlayer<L, A, S> {
    fn load(&mut self, path: &Path, duration_hint: Option<f64>) {
        self.stop();
        (self.path, self.duration, self.base_ms, self.state) = (Some(path.to_path_buf()), duration_hint, 0, PreviewState::Ready);
    }

    fn play(&mut self) {
        match self.state {
            PreviewState::Idle | PreviewState::Playing | PreviewState::Error(_) => {}
            PreviewState::Ended => {
                self.base_ms = 0;
                self.start();
            }
            _ => self.start(),
        }
    }

    fn pause(&mut self) {
        if self.state == PreviewState::Playing {
            self.base_ms = (self.time() * 1000.0).round() as i64;
            self.stop();
            self.audio.set_paused(true);
            self.state = PreviewState::Ready;
        }
    }

    fn seek(&mut self, seconds: f64) {
        self.base_ms = (seconds.max(0.0) * 1000.0).round() as i64;
        if self.state == PreviewState::Playing {
            self.start();
        } else {
            self.stop();
        }
    }

    fn set_muted(&mut self, muted: bool) {
        self.audio.set_muted(muted);
    }

    fn time(&self) -> f64 {
        let ms = if self.state == PreviewState::Playing { self.base_ms + self.audio.played_ms() } else { self.base_ms };
        let t = ms as f64 / 1000.0;
        self.duration.map_or(t, |d| t.min(d))
    }

    fn duration(&self) -> Option<f64> {
        self.duration
    }

    fn state(&self) -> PreviewState {
        self.state.clone()
    }

    fn pump(&mut self) {
        if self.state != PreviewState::Playing {
            return;
        }
        self.take_sound();
        self.take_frames();
        let pts: Vec<i64> = self.frames.iter().map(|(p, _)| *p).collect();
        if let Some(i) = pick_frame(&pts, self.base_ms + self.audio.played_ms()) {
            let (_, frame) = self.frames.drain(..=i).next_back().expect("pick_frame gave a held index");
            self.shown += 1;
            self.sink.show(frame, self.shown);
        }
        match self.video_exit {
            Some(0) if self.frames.is_empty() => {
                self.stop();
                (self.base_ms, self.state) = (self.duration.map_or(self.base_ms, |d| (d * 1000.0).round() as i64), PreviewState::Ended);
            }
            Some(code) if code != 0 => {
                self.stop();
                self.state = PreviewState::Error(format!("ffmpeg stopped with code {code}"));
            }
            _ => {}
        }
    }

    fn paint(&self, stage: El) -> El {
        self.sink.paint(stage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct World {
        spawned: Vec<Vec<String>>,
        killed: usize,
        ms: i64,
        shown: Vec<u8>,
        written: usize,
        /// What the next video pipe says, front first.
        video: VecDeque<Chunk>,
    }
    type Shared = Arc<Mutex<World>>;

    struct FakePipe(Shared, bool, bool);
    impl Pipe for FakePipe {
        fn next(&mut self) -> Chunk {
            let mut w = self.0.lock().unwrap();
            match (self.1, std::mem::replace(&mut self.2, true)) {
                (true, _) => w.video.pop_front().unwrap_or(Chunk::Idle),
                (false, false) => Chunk::Data(vec![0; 4]),
                (false, true) => Chunk::Idle,
            }
        }
        fn kill(&mut self) {
            self.0.lock().unwrap().killed += 1;
        }
    }
    struct FakeLauncher(Shared);
    impl Launcher for FakeLauncher {
        fn spawn(&self, args: Vec<String>) -> io::Result<Box<dyn Pipe>> {
            let is_video = args.contains(&"rawvideo".to_string());
            self.0.lock().unwrap().spawned.push(args);
            Ok(Box::new(FakePipe(self.0.clone(), is_video, false)))
        }
    }
    struct FakeAudio(Shared);
    impl AudioOut for FakeAudio {
        fn write(&mut self, pcm: &[u8]) {
            self.0.lock().unwrap().written += pcm.len();
        }
        fn played_ms(&self) -> i64 {
            self.0.lock().unwrap().ms
        }
        fn set_paused(&mut self, _: bool) {}
        fn clear(&mut self) {
            self.0.lock().unwrap().ms = 0;
        }
        fn set_muted(&mut self, _: bool) {}
    }
    struct FakeSink(Shared);
    impl FrameSink for FakeSink {
        fn show(&mut self, bgra: Vec<u8>, _: u64) {
            self.0.lock().unwrap().shown.push(bgra[0]);
        }
        fn paint(&self, stage: El) -> El {
            stage
        }
    }

    fn frame(tag: u8) -> Chunk {
        Chunk::Data(vec![tag; FRAME_BYTES])
    }

    fn player(world: &Shared) -> FfmpegPlayer<FakeLauncher, FakeAudio, FakeSink> {
        let mut p = FfmpegPlayer::new(FakeLauncher(world.clone()), FakeAudio(world.clone()), FakeSink(world.clone()));
        p.open(Path::new("clip.mp4"), Some(20.0));
        p
    }

    /// Play, seek, pause and an ffmpeg exit: what is shown, which processes run, and the state.
    #[test]
    fn play_seek_pause_and_exit_table() {
        let world: Shared = Default::default();
        let mut p = player(&world);
        assert_eq!((p.state(), p.time()), (PreviewState::Ready, 0.0));

        // play: three pictures decoded (pts 0, 33, 66 ms); the sound is at 40 ms, so the second shows
        world.lock().unwrap().video.extend([frame(1), frame(2), frame(3)]);
        p.play();
        world.lock().unwrap().ms = 40;
        p.pump();
        {
            let w = world.lock().unwrap();
            assert_eq!((p.state(), w.shown.clone(), w.written), (PreviewState::Playing, vec![2], 4));
            assert!(w.spawned[0].windows(2).any(|a| a == ["-ss", "0.000"]));
        }
        assert_eq!(p.time(), 0.04);

        // seek while playing restarts both processes at the new place
        p.seek(12.345);
        {
            let w = world.lock().unwrap();
            assert_eq!((w.spawned.len(), w.killed), (4, 2));
            assert!(w.spawned[2].windows(2).any(|a| a == ["-ss", "12.345"]));
        }

        // pause keeps the place and stops the processes; play resumes from it
        world.lock().unwrap().ms = 500;
        p.pause();
        assert_eq!((p.state(), p.time(), world.lock().unwrap().killed), (PreviewState::Ready, 12.845, 4));
        p.play();
        assert!(world.lock().unwrap().spawned[4].windows(2).any(|a| a == ["-ss", "12.845"]));

        // ffmpeg exits with an error: the state says so; a clean end after the last picture is Ended
        world.lock().unwrap().video.push_back(Chunk::Ended(1));
        p.pump();
        assert_eq!(p.state(), PreviewState::Error("ffmpeg stopped with code 1".into()));
        p.load(Path::new("clip.mp4"), Some(20.0));
        p.play();
        world.lock().unwrap().video.push_back(Chunk::Ended(0));
        p.pump();
        assert_eq!((p.state(), p.time()), (PreviewState::Ended, 20.0));
        p.play();
        assert_eq!(p.state(), PreviewState::Playing, "play after the end starts again");
        p.seek(-5.0);
        assert_eq!(p.time(), 0.0, "a seek before the start clamps to 0");
    }

    #[test]
    fn a_missing_ffmpeg_is_an_error_state() {
        struct Missing;
        impl Launcher for Missing {
            fn spawn(&self, _: Vec<String>) -> io::Result<Box<dyn Pipe>> {
                Err(io::Error::new(io::ErrorKind::NotFound, "no ffmpeg"))
            }
        }
        let world: Shared = Default::default();
        let mut p = FfmpegPlayer::new(Missing, FakeAudio(world.clone()), FakeSink(world));
        p.play();
        assert_eq!(p.state(), PreviewState::Idle, "nothing loaded: nothing happens");
        p.open(Path::new("x.mp4"), None);
        p.play();
        assert_eq!(p.state(), PreviewState::Error("ffmpeg could not start: no ffmpeg".into()));
        p.pump();
        assert_eq!((p.duration(), p.state() == PreviewState::Idle), (None, false));
    }
}
