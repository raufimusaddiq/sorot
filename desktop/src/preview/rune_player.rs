//! Windows and macOS: Rune's own `Player` (Media Foundation, AVFoundation) behind `Preview`.

use std::path::Path;

use rune::{El, Player, PlayerState, SurfaceFit};

use super::{Preview, PreviewState};

pub fn new() -> Box<dyn Preview> {
    Box::new(RunePlayer::default())
}

#[derive(Default)]
pub struct RunePlayer {
    player: Option<Player>,
}

impl Preview for RunePlayer {
    fn load(&mut self, path: &Path, _: Option<f64>) {
        self.player = Some(Player::file(path));
    }
    fn play(&mut self) {
        if let Some(p) = &self.player {
            p.play();
        }
    }
    fn pause(&mut self) {
        if let Some(p) = &self.player {
            p.pause();
        }
    }
    fn seek(&mut self, seconds: f64) {
        if let Some(p) = &self.player {
            p.seek(seconds);
        }
    }
    fn set_muted(&mut self, muted: bool) {
        if let Some(p) = &self.player {
            p.set_muted(muted);
        }
    }
    fn time(&self) -> f64 {
        self.player.as_ref().map_or(0.0, Player::time)
    }
    fn duration(&self) -> Option<f64> {
        self.player.as_ref().and_then(Player::duration)
    }
    fn state(&self) -> PreviewState {
        match self.player.as_ref().map(Player::state) {
            None => PreviewState::Idle,
            Some(PlayerState::Loading) => PreviewState::Loading,
            Some(PlayerState::Playing) => PreviewState::Playing,
            Some(PlayerState::Ended) => PreviewState::Ended,
            Some(PlayerState::Failed(why)) => PreviewState::Error(why),
            Some(_) => PreviewState::Ready,
        }
    }
    fn paint(&self, stage: El) -> El {
        match &self.player {
            Some(p) => stage.video(p, SurfaceFit::Fit),
            None => stage,
        }
    }
}
