'use client';

// Collapsible per-import settings: caption style, framing, editing passes,
// YouTube captions, background music and an optional time range.

import { useState } from 'react';
import type { EditChoices, PipelineOptions } from '@/types';

export type ImportSettings = {
  options: PipelineOptions;
  startTime: string;
  endTime: string;
};

export const FALLBACK_CHOICES: EditChoices = {
  styles: ['default', 'hormozi', 'storyteller', 'cinematic'],
  reframeModes: ['face', 'center', 'blur'],
  music: [],
  defaults: {
    style: 'default', reframe: 'face', silenceTrim: false, silenceGapSec: 0.6, hookFirst: false,
    youtubeCaptions: false, allowAutoCaptions: false, bgm: '', bgmVolume: 0.12,
  },
};

export const REFRAME_LABELS: Record<string, string> = {
  face: 'Follow faces',
  center: 'Centre crop',
  blur: 'Full frame + blur',
};

const label = 'text-xs text-muted font-medium block mb-1';
const field = 'w-full bg-surface-2 border border-line rounded px-2 py-1.5 text-sm text-fg';

export function Toggle({ checked, onChange, children }: {
  checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {children}
    </label>
  );
}

export function MusicPicker({ choices, bgm, volume, onChange }: {
  choices: EditChoices; bgm: string; volume: number;
  onChange: (patch: PipelineOptions) => void;
}) {
  return (
    <div>
      <span className={label}>Background music</span>
      <select aria-label="Background music" value={bgm} onChange={(e) => onChange({ bgm: e.target.value })} className={field}>
        <option value="">None</option>
        {choices.music.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {choices.music.length === 0 && (
        <p className="text-xs text-subtle mt-1">Put .mp3/.m4a files in <span className="font-mono">data/music</span> to use them.</p>
      )}
      {bgm && (
        <label className="text-xs text-muted flex items-center gap-2 mt-2">
          Volume
          <input type="range" aria-label="Music volume" min={0} max={0.5} step={0.01} value={volume}
            onChange={(e) => onChange({ bgmVolume: Number(e.target.value) })} className="flex-1 accent-accent" />
          <span className="font-mono w-10 text-right">{Math.round(volume * 100)}%</span>
        </label>
      )}
    </div>
  );
}

export function ImportOptions({ value, onChange, choices, disabled }: {
  value: ImportSettings;
  onChange: (next: ImportSettings) => void;
  choices: EditChoices;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const o = { ...choices.defaults, ...value.options };
  const set = (patch: PipelineOptions) => onChange({ ...value, options: { ...value.options, ...patch } });

  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen(!open)} disabled={disabled}
        className="text-xs text-muted hover:text-fg font-medium" aria-expanded={open}>
        {open ? '▾' : '▸'} Options
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 bg-surface-2/40 border border-line rounded p-4">
          <div>
            <span className={label}>Caption style</span>
            <select aria-label="Caption style" value={o.style} onChange={(e) => set({ style: e.target.value })} className={field}>
              {choices.styles.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <span className={label}>Framing</span>
            <select aria-label="Framing" value={o.reframe} onChange={(e) => set({ reframe: e.target.value })} className={field}>
              {choices.reframeModes.map((m) => <option key={m} value={m}>{REFRAME_LABELS[m] ?? m}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Toggle checked={o.silenceTrim} onChange={(v) => set({ silenceTrim: v })}>Cut silences</Toggle>
            <Toggle checked={o.hookFirst} onChange={(v) => set({ hookFirst: v })}>Hook first (replay best line at the start)</Toggle>
            <Toggle checked={o.youtubeCaptions} onChange={(v) => set({ youtubeCaptions: v })}>Use YouTube captions when available</Toggle>
            {o.youtubeCaptions && (
              <div className="pl-6">
                <Toggle checked={o.allowAutoCaptions} onChange={(v) => set({ allowAutoCaptions: v })}>…including auto-generated</Toggle>
              </div>
            )}
          </div>
          <MusicPicker choices={choices} bgm={o.bgm} volume={o.bgmVolume} onChange={set} />
          <div className="md:col-span-2">
            <span className={label}>Only process part of the video (optional)</span>
            <div className="flex items-center gap-2">
              <input aria-label="From" placeholder="From e.g. 13:25" value={value.startTime}
                onChange={(e) => onChange({ ...value, startTime: e.target.value })} className={field} />
              <span className="text-subtle">→</span>
              <input aria-label="To" placeholder="To e.g. 25:00" value={value.endTime}
                onChange={(e) => onChange({ ...value, endTime: e.target.value })} className={field} />
            </div>
            <p className="text-xs text-subtle mt-1">YouTube downloads only this window. Formats: 85, 1:25, 1:02:03, 13m25s.</p>
          </div>
        </div>
      )}
    </div>
  );
}
