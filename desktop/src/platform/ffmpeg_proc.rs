//! OS shim (Linux): ffmpeg processes for `preview::ffmpeg_player`, and the picture hand-off to
//! Rune's surface. Logic-free: threads move bytes, nothing is decided here.

use std::io::{self, Read};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, TryRecvError, sync_channel};

use rune::native_surface::{ByteFrame, Format};
use rune::{El, NativeSurface, SurfaceFit};

use crate::preview::ffmpeg_player::{Chunk, FrameSink, HEIGHT, Launcher, Pipe, WIDTH};

/// The Linux player: ffmpeg from `SOROT_FFMPEG` or the path, the default sound card, a Rune surface.
pub fn preview() -> Box<dyn crate::preview::Preview> {
    let ffmpeg = std::env::var("SOROT_FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let player = crate::preview::ffmpeg_player::FfmpegPlayer::new(Ffmpeg(ffmpeg.into()), super::audio_cpal::Cpal::default(), Surface(NativeSurface::new()));
    Box::new(player)
}

pub struct Ffmpeg(pub std::path::PathBuf);

struct Proc {
    child: Child,
    rx: Receiver<Vec<u8>>,
}

impl Pipe for Proc {
    fn next(&mut self) -> Chunk {
        match self.rx.try_recv() {
            Ok(bytes) => Chunk::Data(bytes),
            Err(TryRecvError::Empty) => Chunk::Idle,
            Err(TryRecvError::Disconnected) => Chunk::Ended(self.child.wait().ok().and_then(|s| s.code()).unwrap_or(-1)),
        }
    }
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Launcher for Ffmpeg {
    fn spawn(&self, args: Vec<String>) -> io::Result<Box<dyn Pipe>> {
        let mut child = Command::new(&self.0).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let mut out = child.stdout.take().expect("stdout was piped");
        let (tx, rx) = sync_channel(8);
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 1 << 16];
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        Ok(Box::new(Proc { child, rx }))
    }
}

/// Pictures into a Rune surface.
pub struct Surface(pub NativeSurface);

impl FrameSink for Surface {
    fn show(&mut self, bgra: Vec<u8>, id: u64) {
        let frame = ByteFrame { width: WIDTH, height: HEIGHT, format: Format::Bgra, color: Default::default(), planes: [bgra, vec![]] };
        let _ = self.0.push_bytes(frame, id);
    }
    fn paint(&self, stage: El) -> El {
        stage.native_surface(&self.0, SurfaceFit::Fit)
    }
}
