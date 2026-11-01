'use client';

// The brief: what the video is about, and the choices that go with it. Files (a logo, images,
// fonts, music) are uploaded right after the project is created, in time for the plan.

import { useState } from 'react';
import type { GenCreateBody } from '@/types';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

export const MAX_BRIEF = 2000;
export type PendingFile = { file: File; kind: string };

const KINDS: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', svg: 'image',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  mp3: 'music', m4a: 'music', wav: 'music', ogg: 'music',
};

/** What a file is for, from its extension; null for a type Generate can't use. */
export function assetKind(filename: string): string | null {
  return KINDS[filename.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export function BriefForm({ busy, recipes, voiceEngines, onCreate }: {
  busy: boolean;
  /** Voice engines that are set up; narration is offered only when there is one. */
  voiceEngines?: string[];
  /** Offered when there is more than one; the first is the default. */
  recipes?: Array<{ id: string; name: string }>;
  onCreate: (body: GenCreateBody, files: PendingFile[]) => void;
}) {
  const [brief, setBrief] = useState('');
  const [format, setFormat] = useState('9:16');
  const [length, setLength] = useState('30');
  const [language, setLanguage] = useState('id');
  const [style, setStyle] = useState('');
  const [narration, setNarration] = useState(false);
  const [factsText, setFactsText] = useState('');
  const [noNumbers, setNoNumbers] = useState(false);
  const canNarrate = (voiceEngines?.length ?? 0) > 0;
  const [recipeId, setRecipeId] = useState(recipes?.[0]?.id ?? '');
  const [logo, setLogo] = useState<File | null>(null);
  const [others, setOthers] = useState<File[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const seconds = Number(length);
  const lengthOk = Number.isInteger(seconds) && seconds >= 5 && seconds <= 90;
  const ready = brief.trim().length > 0 && brief.length <= MAX_BRIEF && lengthOk && !busy;

  const submit = () => {
    const files: PendingFile[] = logo ? [{ file: logo, kind: 'logo' }] : [];
    for (const file of others) {
      const kind = assetKind(file.name);
      if (!kind) return setProblem(`${file.name}: Generate can use images, fonts (.ttf .otf .woff .woff2) and music (.mp3 .m4a .wav .ogg)`);
      files.push({ file, kind });
    }
    const facts: NonNullable<GenCreateBody['facts']> = [];
    for (const line of factsText.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const parts = line.split('|').map((x) => x.trim());
      const sourceUrl = parts.at(-1) ?? '';
      if (parts.length < 2 || !/^https?:\/\//i.test(sourceUrl) || !parts[0]) return setProblem(`"${line.slice(0, 40)}": write each fact as  claim | value | https://address  (the value is optional)`);
      facts.push({ claim: parts[0], ...(parts.length > 2 && parts[1] ? { value: parts[1] } : {}), sourceUrl });
    }
    setProblem(null);
    onCreate({
      brief: brief.trim(), format, targetSec: seconds, language, ...(style.trim() ? { styleNotes: style.trim() } : {}),
      ...(recipes && recipes.length > 1 ? { recipeId } : {}), ...(narration && canNarrate ? { narration: true } : {}),
      ...(facts.length ? { facts } : {}), ...(noNumbers ? { forbiddenNumbers: true as const } : {}),
    }, files);
  };

  return (
    <div className="grid gap-3">
      <label>
        <span className={label}>What is the video about?</span>
        <textarea aria-label="Brief" rows={5} value={brief} maxLength={MAX_BRIEF} placeholder="Jelaskan bunga majemuk dalam 30 detik, untuk anak muda yang baru mulai menabung"
          onChange={(e) => setBrief(e.target.value)} className={field} />
        <span className="text-xs text-subtle" aria-live="polite">{brief.length} / {MAX_BRIEF}</span>
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label>
          <span className={label}>Format</span>
          <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)} className={field}>
            <option value="9:16">9:16 vertical</option><option value="16:9">16:9 wide</option><option value="1:1">1:1 square</option>
          </select>
        </label>
        <label>
          <span className={label}>Length (seconds)</span>
          <input aria-label="Length" type="number" min={5} max={90} value={length} onChange={(e) => setLength(e.target.value)} className={field} />
        </label>
        <label>
          <span className={label}>Language</span>
          <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} className={field}>
            <option value="id">Indonesian</option><option value="en">English</option>
          </select>
        </label>
        {recipes && recipes.length > 1 && (
          <label>
            <span className={label}>Pipeline</span>
            <select aria-label="Recipe" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} className={field}>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {!lengthOk && <p role="alert" className="text-error text-xs">The length is 5 to 90 seconds.</p>}
      <label>
        <span className={label}>Style notes (optional)</span>
        <input aria-label="Style notes" value={style} placeholder="tenang, warna hangat, tanpa teks berlebihan" onChange={(e) => setStyle(e.target.value)} className={field} />
      </label>
      <details>
        <summary className={`${label} cursor-pointer`}>Facts and numbers (optional)</summary>
        <label className="block mt-2">
          <span className={label}>Facts, one per line: claim | value | source address</span>
          <textarea aria-label="Facts" rows={3} value={factsText} onChange={(e) => setFactsText(e.target.value)} className={field}
            placeholder="Suku bunga acuan BI adalah 5,75 persen | 5,75% | https://www.bi.go.id/…" />
        </label>
        <label className="text-sm block mt-2">
          <input type="checkbox" aria-label="No other numbers" checked={noNumbers} onChange={(e) => setNoNumbers(e.target.checked)} /> No numbers beyond the ones in my brief
        </label>
      </details>
      {voiceEngines !== undefined && (
        <label className="text-sm block">
          <input type="checkbox" aria-label="Narrate it" checked={narration && canNarrate} disabled={!canNarrate} onChange={(e) => setNarration(e.target.checked)} /> Narrate it with a voice
          {!canNarrate && <span className="block text-xs text-subtle">Needs a voice engine: add one in Settings → Narration voice.</span>}
        </label>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        <label>
          <span className={label}>Logo (optional)</span>
          <input aria-label="Logo" type="file" accept=".png,.jpg,.jpeg,.webp,.svg" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} className="text-sm" />
        </label>
        <label>
          <span className={label}>Images, fonts or music (optional)</span>
          <input aria-label="More files" type="file" multiple onChange={(e) => setOthers(Array.from(e.target.files ?? []))} className="text-sm" />
        </label>
      </div>
      {problem && <p role="alert" className="text-error text-sm">{problem}</p>}
      <div>
        <button className="btn btn-primary" disabled={!ready} onClick={submit}>{busy ? 'Starting…' : 'Plan my video'}</button>
      </div>
    </div>
  );
}
