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

export function BriefForm({ busy, recipes, onCreate }: {
  busy: boolean;
  /** Offered when there is more than one; the first is the default. */
  recipes?: Array<{ id: string; name: string }>;
  onCreate: (body: GenCreateBody, files: PendingFile[]) => void;
}) {
  const [brief, setBrief] = useState('');
  const [format, setFormat] = useState('9:16');
  const [length, setLength] = useState('30');
  const [language, setLanguage] = useState('id');
  const [style, setStyle] = useState('');
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
    setProblem(null);
    onCreate({
      brief: brief.trim(), format, targetSec: seconds, language, ...(style.trim() ? { styleNotes: style.trim() } : {}),
      ...(recipes && recipes.length > 1 ? { recipeId } : {}),
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
