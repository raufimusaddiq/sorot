//! OS shim (Linux): `cpal` output for `preview::ffmpeg_player::AudioOut`. The played-sample count
//! is the clock the pictures follow. The stream is not `Send`, so a thread owns it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::preview::ffmpeg_player::{AudioOut, SAMPLE_RATE};

pub struct Cpal {
    queue: Arc<Mutex<VecDeque<i16>>>,
    played: Arc<AtomicI64>,
    paused: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Default for Cpal {
    fn default() -> Self {
        let (queue, played) = (Arc::new(Mutex::new(VecDeque::new())), Arc::new(AtomicI64::new(0)));
        let (paused, muted) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicBool::new(false)));
        let (q, p, hold, mute) = (queue.clone(), played.clone(), paused.clone(), muted.clone());
        let (stop, rx) = channel::<()>();
        let thread = std::thread::spawn(move || {
            let config = cpal::StreamConfig { channels: 2, sample_rate: cpal::SampleRate(SAMPLE_RATE), buffer_size: cpal::BufferSize::Default };
            let stream = cpal::default_host().default_output_device().and_then(|d| {
                let s = d.build_output_stream(&config, move |out: &mut [i16], _| {
                    let mut q = q.lock().unwrap();
                    for o in out.iter_mut() {
                        let next = if hold.load(Ordering::Relaxed) { None } else { q.pop_front() };
                        p.fetch_add(i64::from(next.is_some()), Ordering::Relaxed);
                        *o = next.filter(|_| !mute.load(Ordering::Relaxed)).unwrap_or(0);
                    }
                }, |_| {}, None).ok()?;
                s.play().ok()?;
                Some(s)
            });
            let _ = rx.recv();
            drop(stream);
        });
        Cpal { queue, played, paused, muted, stop: Some(stop), thread: Some(thread) }
    }
}

impl Drop for Cpal {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl AudioOut for Cpal {
    fn write(&mut self, pcm: &[u8]) {
        self.queue.lock().unwrap().extend(pcm.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)));
    }
    fn played_ms(&self) -> i64 {
        self.played.load(Ordering::Relaxed) * 1000 / (2 * i64::from(SAMPLE_RATE))
    }
    fn set_paused(&mut self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }
    fn clear(&mut self) {
        self.queue.lock().unwrap().clear();
        self.played.store(0, Ordering::Relaxed);
    }
    fn set_muted(&mut self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
}
