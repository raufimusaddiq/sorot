'use client';

// Clip editor: nudge the clip's start/end, override caption style / framing /
// editing passes / music for this clip, fix misheard caption words, then
// re-render just this clip.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { CaptionWord, Clip, EditChoices, PipelineOptions } from '@/types';
import { formatTime, tierLabel } from '@/lib/ui-utils';
import { MusicPicker, REFRAME_LABELS, Toggle } from './ImportOptions';

const STEP = 0.5;
const field = 'w-full bg-surface-2 border border-line rounded px-2 py-1.5 text-sm text-fg';
const label = 'text-xs text-muted font-medium block mb-1';

function parseClipOptions(json?: string | null): PipelineOptions {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function ClipEditor({ clip, api, choices, onClose, onSaved }: {
  clip: Clip;
  api: ApiClient;
  choices: EditChoices;
  onClose: () => void;
  onSaved: (clip: Clip) => void;
}) {
  const [start, setStart] = useState(clip.startTime);
  const [end, setEnd] = useState(clip.endTime);
  const [options, setOptions] = useState<PipelineOptions>(() => parseClipOptions(clip.options));
  const [words, setWords] = useState<CaptionWord[] | null>(null);
  const [edited, setEdited] = useState(false);
  const [dirtyWords, setDirtyWords] = useState(false);
  const [resetWords, setResetWords] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getClipCaptions(clip.id)
      .then((r) => { if (live) { setWords(r.words); setEdited(r.edited); } })
      .catch((e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load captions'); });
    return () => { live = false; };
  }, [api, clip.id]);

  const o = { ...choices.defaults, ...options };
  const set = (patch: PipelineOptions) => setOptions((prev) => ({ ...prev, ...patch }));
  const duration = end - start;
  const invalid = duration < 3 || duration > 180 || start < 0;

  const editWord = (i: number, text: string) => {
    setWords((ws) => ws && ws.map((w, j) => (j === i ? { ...w, text } : w)));
    setDirtyWords(true);
    setResetWords(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const captionWords = resetWords ? null : dirtyWords && words ? words : undefined;
      const { clip: saved } = await api.rerenderClip(clip.id, { startTime: start, endTime: end, options, captionWords });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-render failed');
    } finally {
      setSaving(false);
    }
  };

  const nudge = (which: 'start' | 'end', delta: number) =>
    (which === 'start' ? setStart : setEnd)((v) => Math.max(0, Number((v + delta).toFixed(2))));

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" role="dialog" aria-label="Edit clip">
      <div className="bg-surface rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto border border-line">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="text-lg font-semibold text-fg">
            Edit clip #{clip.rankPos ?? '-'} <span className="text-xs text-subtle font-normal ml-2">{tierLabel(clip.tier)}</span>
          </h3>
          <button onClick={onClose} aria-label="Close editor" className="text-muted hover:text-fg">✕</button>
        </div>

        <div className="p-5 space-y-6">
          <section>
            <h4 className="text-sm font-semibold text-fg mb-3">Timing</h4>
            <div className="grid grid-cols-2 gap-4">
              {(['start', 'end'] as const).map((which) => (
                <div key={which}>
                  <span className={label}>{which === 'start' ? 'Start' : 'End'} ({formatTime(which === 'start' ? start : end)})</span>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => nudge(which, -STEP)} className="px-2 rounded bg-surface-3 text-xs">−{STEP}s</button>
                    <input type="number" step={0.1} aria-label={which === 'start' ? 'Start seconds' : 'End seconds'}
                      value={which === 'start' ? start : end}
                      onChange={(e) => (which === 'start' ? setStart : setEnd)(Number(e.target.value))} className={field} />
                    <button type="button" onClick={() => nudge(which, STEP)} className="px-2 rounded bg-surface-3 text-xs">+{STEP}s</button>
                  </div>
                </div>
              ))}
            </div>
            <p className={`text-xs mt-2 ${invalid ? 'text-error' : 'text-subtle'}`}>
              Length {duration.toFixed(1)} s{invalid ? ' — must be 3–180 s' : ''}
            </p>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className={label}>Caption style</span>
              <select aria-label="Clip caption style" value={o.style} onChange={(e) => set({ style: e.target.value })} className={field}>
                {choices.styles.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <span className={label}>Framing</span>
              <select aria-label="Clip framing" value={o.reframe} onChange={(e) => set({ reframe: e.target.value })} className={field}>
                {choices.reframeModes.map((m) => <option key={m} value={m}>{REFRAME_LABELS[m] ?? m}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Toggle checked={o.silenceTrim} onChange={(v) => set({ silenceTrim: v })}>Cut silences</Toggle>
              <Toggle checked={o.hookFirst} onChange={(v) => set({ hookFirst: v })}>Hook first</Toggle>
            </div>
            <MusicPicker choices={choices} bgm={o.bgm} volume={o.bgmVolume} onChange={set} />
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-fg">
                Captions {edited && !resetWords && <span className="text-xs text-accent font-normal ml-1">(edited)</span>}
              </h4>
              {(edited || dirtyWords) && !resetWords && (
                <button type="button" onClick={() => { setResetWords(true); setDirtyWords(false); }}
                  className="text-xs text-muted hover:text-fg">Reset to transcript</button>
              )}
            </div>
            <p className="text-xs text-subtle mb-2">Fix misheard words (names, slang). Clear a word to drop it from the captions.</p>
            {loadError && <p className="text-xs text-error">{loadError}</p>}
            {!words && !loadError && <p className="text-xs text-subtle">Loading captions…</p>}
            {resetWords && <p className="text-xs text-warning">Captions will be regenerated from the transcript.</p>}
            {words && !resetWords && (
              <div className="flex flex-wrap gap-1">
                {words.map((w, i) => (
                  <input key={`${w.start}-${i}`} value={w.text} aria-label={`Word ${i + 1}`}
                    title={`${formatTime(w.start)}`}
                    onChange={(e) => editWord(i, e.target.value)}
                    style={{ width: `${Math.max(3, w.text.length + 1)}ch` }}
                    className={`bg-surface-2 border rounded px-1 py-0.5 text-sm ${w.text ? 'border-line text-fg' : 'border-error/40'}`} />
                ))}
                {words.length === 0 && <p className="text-xs text-subtle">No speech in this clip.</p>}
              </div>
            )}
          </section>

          {error && <p className="text-sm text-error bg-error-tint border border-error/30 rounded px-3 py-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-line">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm bg-surface-3 text-fg/85">Cancel</button>
          <button onClick={save} disabled={saving || invalid}
            className="px-4 py-2 rounded text-sm font-medium bg-accent text-white disabled:bg-surface-3 disabled:text-subtle">
            {saving ? 'Re-rendering…' : 'Save & re-render'}
          </button>
        </div>
      </div>
    </div>
  );
}
