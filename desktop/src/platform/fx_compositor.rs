//! OS shim: draws the rune-fx layers that `ui::fx_moments` plans for the app's effect slots, in
//! Rune's frame. No logic of its own: what to draw, and when, is decided there and tested there.

use rune::render::{EffectPhase, KIND_EFFECT};
use rune::{Compositor, Frame};
use rune_fx::{FxFrame, FxLayer, FxOptions, FxRenderer};

use crate::app::State;
use crate::ui::fx_moments::{Look, Moment, Placed, animating, layers, rank_layers};

#[derive(Default)]
pub struct FxCompositor {
    fx: Option<(FxRenderer, wgpu::TextureFormat)>,
    /// Draws the rank blur alone: its source is the frame copy of its own slot.
    blur: Option<FxRenderer>,
    moving: bool,
}

impl Compositor<State> for FxCompositor {
    fn animating(&self) -> bool {
        self.moving
    }

    fn render(&mut self, f: &mut Frame<'_, State>) {
        let (scale, t) = (f.rt.env.scale, f.rt.t as f32);
        let look = Look { reduced: f.rt.reduced_motion, cpu: f.rt.state.cpu_renderer };
        let (mut drawn, mut owner): (Vec<FxLayer>, Vec<(u32, [f32; 4])>) = (vec![], vec![]);
        self.moving = false;
        for i in f.rt.instances.iter().filter(|i| i.params[1] == KIND_EFFECT) {
            let mark = (i.border[0] as u32 & 0xFFFF) | (i.border[1] as u32 & 0xFFFF) << 16;
            let Some(moment) = Moment::from_mark(mark) else { continue };
            let rect = rune_fx::Rect::new(i.rect[0] / scale, i.rect[1] / scale, i.rect[2] / scale, i.rect[3] / scale);
            let placed = Placed { moment, data: i.uv, rect, scale };
            self.moving |= animating(placed, t, look);
            // A layer that reads a captured copy of its node has none to read here: it is not drawn.
            for l in layers(placed, t, look).into_iter().filter(|l| l.source.is_none()) {
                drawn.push(l);
                owner.push((mark, i.rect));
            }
        }
        if self.fx.as_ref().is_none_or(|(_, format)| *format != f.format) {
            let mut fx = FxRenderer::new(f.device, f.format, FxOptions::default());
            fx.add_format(f.device, wgpu::TextureFormat::Rgba16Float);
            self.fx = Some((fx, f.format));
        }
        let (fx, _) = self.fx.as_mut().expect("made above");
        let blur = self.blur.get_or_insert_with(|| FxRenderer::new(f.device, f.format, FxOptions::default()));
        blur.add_format(f.device, wgpu::TextureFormat::Rgba16Float);
        blur.set_srgb_blend(!f.ui.srgb_blend()); // its source is a copy in the other encoding than the pass
        let moving = f.rt.state.clips.rank_blurs(t, |k| f.rt.presented(k).map(|(r, _)| rune_fx::Rect::new(r[0], r[1], r[2], r[3])));
        let blurred = rank_layers(&moving, rune_fx::Rect::new(0.0, 0.0, f.size.0 as f32 / scale, f.size.1 as f32 / scale), t, scale, look);
        self.moving |= !blurred.is_empty();
        fx.set_srgb_blend(f.ui.srgb_blend());
        fx.prepare(f.device, f.queue, &FxFrame { viewport: [f.size.0, f.size.1], scale, layers: &drawn, backdrop: None, sources: &[] });
        let clear = f.rt.clear_color();
        f.ui.prepare(f.device, f.queue, &mut f.rt.text.atlas, &f.rt.instances, f.size);
        let (device, queue) = (f.device, f.queue);
        f.ui.draw_with_backdrop(f.encoder, f.target, clear, &mut |phase, site| {
            if site.mark == Moment::RankBlur.mark() {
                match phase {
                    EffectPhase::Backdrop(_) => drop(blur.prepare(device, queue, &FxFrame { viewport: [site.size[0], site.size[1]], scale, layers: &blurred, backdrop: None, sources: &[site.backdrop.expect("asked for")] })),
                    EffectPhase::Draw(pass) => (0..blurred.len()).for_each(|n| blur.draw_layer_in(pass, site.format, site.origin, n)),
                }
                return;
            }
            let mine = owner.iter().enumerate().filter(|(_, o)| **o == (site.mark, site.instance.rect)).map(|(n, _)| n);
            match phase {
                EffectPhase::Backdrop(encoder) => mine.filter(|n| drawn[*n].fx.needs_backdrop()).for_each(|n| {
                    site.backdrop.map(|b| fx.blur_backdrop(device, queue, encoder, b, n));
                }),
                EffectPhase::Draw(pass) => mine.for_each(|n| fx.draw_layer_in(pass, site.format, site.origin, n)),
            }
        });
    }
}
