'use client';

// The director's storylines: different films, one recommended. Pick one (with an optional note
// the plan takes into account), or ask for new ones.

import { useState } from 'react';
import type { GenStoryline } from '@/types';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

export function StorylineCards({ storylines, picked, busy, onPick, onMore }: {
  storylines: GenStoryline[];
  picked: number | null;
  busy: boolean;
  onPick: (index: number, note: string) => void;
  onMore: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="grid gap-3">
      <p className="text-sm text-fg/80">Pick the film you want. The plan is written from it.</p>
      <div className="grid gap-3 md:grid-cols-3">
        {storylines.map((s, i) => (
          <article key={i} aria-label={`Storyline ${i + 1}: ${s.title}`} className={`border-3 border-line p-3 bg-surface ${i === picked ? 'shadow-hard' : ''}`}>
            <h3 className="heading text-base mb-1">{s.title}</h3>
            <p className="flex gap-1 mb-2">
              {s.recommended && <span className="text-xs border-2 border-line px-1 bg-sun">recommended</span>}
              {s.bold && <span className="text-xs border-2 border-line px-1 bg-hot text-white">bold</span>}
              {i === picked && <span className="text-xs border-2 border-line px-1 bg-mint">picked</span>}
            </p>
            <p className="text-sm mb-2">{s.pitch}</p>
            <p className="text-xs text-subtle mb-1"><b>First 2 s:</b> {s.opening}</p>
            <p className="text-xs text-subtle mb-1"><b>Beats:</b> {s.beats.join(' → ')}</p>
            <p className="text-xs text-subtle mb-1"><b>Look:</b> {s.look} · <b>Sound:</b> {s.sound}</p>
            {s.reason && <p className="text-xs italic mb-2">{s.reason}</p>}
            <button className="btn btn-primary" disabled={busy} onClick={() => onPick(i, note)} aria-label={`Use storyline ${i + 1}`}>Use this one</button>
          </article>
        ))}
      </div>
      <label>
        <span className={label}>A note for the director (optional)</span>
        <input aria-label="Note for the director" value={note} placeholder="lebih tenang, tanpa karakter" onChange={(e) => setNote(e.target.value)} className={field} />
      </label>
      <div>
        <button className="btn" disabled={busy} onClick={() => onMore(note)}>Show me different ones</button>
      </div>
    </div>
  );
}
