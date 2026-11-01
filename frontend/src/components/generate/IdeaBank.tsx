'use client';

// The idea bank: briefs lined up for later. "Run the next idea" carries the recipe's next new idea
// to an exported video without stopping (every gate has to be the director's; an owner gate leaves
// the video waiting at that step). Naming an idea starts or resumes it and never moves the cursor.

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { GenIdea } from '@/types';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';
const BADGE: Record<GenIdea['status'], string> = { new: 'bg-surface-3', used: 'bg-sun', built: 'bg-aqua', posted: 'bg-mint' };

export function IdeaBank({ api, recipes, onOpen }: {
  api: ApiClient;
  /** The recipes that can run here. */
  recipes: Array<{ id: string; name: string }>;
  /** Opens the video a run made or resumed. */
  onOpen: (projectId: string) => void;
}) {
  const [ideas, setIdeas] = useState<GenIdea[] | null>(null);
  const [recipeId, setRecipeId] = useState(recipes[0]?.id ?? 'quick');
  const [slug, setSlug] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.listGenerateIdeas().then((r) => setIdeas(r.ideas), (e) => setError((e as Error).message)), [api]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const run = (ideaId?: string) => act(async () => {
    const { project } = await api.runGenerateIdea({ recipeId, ...(ideaId ? { ideaId } : {}) });
    onOpen(project.id);
  });
  const add = () => act(async () => {
    await api.addGenerateIdea({ slug: slug.trim(), brief: brief.trim() });
    setSlug('');
    setBrief('');
    await load();
  });

  if (ideas === null) return error ? <p role="alert" className="text-error text-sm">{error}</p> : null;
  const waiting = ideas.filter((i) => i.status === 'new').length;
  return (
    <section aria-label="Ideas" className="grid gap-3">
      <p className="text-xs text-subtle">Briefs lined up for later. A run takes the next new idea and carries it to an exported video; a step that waits for you (an owner gate) stops it there. Publishing is always yours to do.</p>
      <div className="flex flex-wrap items-center gap-2">
        {recipes.length > 1 && (
          <select aria-label="Recipe for the run" value={recipeId} className="field px-2 py-1.5" onChange={(e) => setRecipeId(e.target.value)}>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <button className="btn btn-primary" disabled={busy || waiting === 0} onClick={() => run()}>
          {waiting ? `Run the next idea (${waiting} waiting)` : 'No new ideas to run'}
        </button>
      </div>
      {ideas.length === 0 && <p className="text-sm">No ideas yet.</p>}
      <ul className="grid gap-2">
        {ideas.map((i) => (
          <li key={i.id} className="border-2 border-line bg-surface p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs border-2 border-line px-1 ${BADGE[i.status]}`}>{i.status}</span>
              <b className="text-sm">{i.slug}</b>
              <span className="text-xs text-subtle">{i.id.length > 12 ? i.id.slice(0, 8) : i.id}</span>
              <span className="ml-auto flex gap-1">
                {i.projectId && <button className="btn" aria-label={`Open ${i.slug}`} onClick={() => onOpen(i.projectId as string)}>Open</button>}
                <button className="btn" aria-label={`${i.status === 'new' ? 'Run' : 'Resume'} ${i.slug}`} disabled={busy || i.status === 'posted'} onClick={() => run(i.id)}>
                  {i.status === 'new' ? 'Run this' : 'Resume'}
                </button>
                <button className="btn" aria-label={`Delete ${i.slug}`} disabled={busy} onClick={() => act(async () => { await api.deleteGenerateIdea(i.id); await load(); })}>✕</button>
              </span>
            </div>
            <p className="text-sm mt-1">{i.brief}</p>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 border-t-2 border-line pt-2">
        <span className={label}>Add an idea</span>
        <input aria-label="Idea name" value={slug} placeholder="bunga-majemuk" onChange={(e) => setSlug(e.target.value)} className={field} />
        <textarea aria-label="Idea brief" rows={3} value={brief} placeholder="Jelaskan bunga majemuk untuk anak muda yang baru menabung" onChange={(e) => setBrief(e.target.value)} className={field} />
        <div><button className="btn" disabled={busy || !slug.trim() || !brief.trim()} onClick={add}>Add idea</button></div>
      </div>
      {error && <p role="alert" className="text-error text-sm">{error}</p>}
    </section>
  );
}
