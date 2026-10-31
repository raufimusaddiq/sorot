'use client';

// The plan, shot by shot. Edit it directly, ask the director for a change in plain words, then
// approve: nothing is built from a plan that isn't approved. Every change is a new revision.

import { useEffect, useState } from 'react';
import type { GenPlan, GenPlanRow, GenShot } from '@/types';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

export function PlanEditor({ plans, targetSec, busy, onSave, onRevise, onApprove }: {
  /** Newest revision first; the first is the current plan. */
  plans: GenPlanRow[];
  targetSec: number;
  busy: boolean;
  onSave: (plan: GenPlan) => void;
  onRevise: (request: string) => void;
  onApprove: (planId: string) => void;
}) {
  const current = plans[0] as GenPlanRow;
  const [draft, setDraft] = useState<GenPlan>(current.plan);
  const [request, setRequest] = useState('');

  // A new revision (an edit saved, a revision from the director) replaces what is on screen.
  useEffect(() => { setDraft(current.plan); }, [current.id, current.plan]);

  const approved = !!current.approvedAt;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.plan);
  const total = Math.round(draft.shots.reduce((n, s) => n + (Number(s.durationSec) || 0), 0) * 10) / 10;
  const offTarget = total < targetSec * 0.9 || total > targetSec * 1.1;

  const shot = (i: number, patch: Partial<GenShot>) =>
    setDraft({ ...draft, shots: draft.shots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const text = (i: number, k: number, value: string) =>
    shot(i, { text: draft.shots[i]!.text.map((t, j) => (j === k ? { ...t, value } : t)) });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="heading text-base">Plan, revision {current.revision}</h3>
        {approved ? <span className="text-xs border-2 border-line px-1 bg-mint">approved</span> : <span className="text-xs border-2 border-line px-1 bg-sun">needs your approval</span>}
        <span className={`text-sm ml-auto ${offTarget ? 'text-error' : 'text-subtle'}`}>{total} s of {targetSec} s</span>
      </div>
      {offTarget && <p role="alert" className="text-error text-xs">The shots should add up to {targetSec} s, give or take 10%.</p>}

      <div className="grid sm:grid-cols-2 gap-3">
        <label>
          <span className={label}>Title</span>
          <input aria-label="Plan title" disabled={approved} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={field} />
        </label>
        <label>
          <span className={label}>The one thing the viewer remembers</span>
          <input aria-label="Plan message" disabled={approved} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} className={field} />
        </label>
      </div>

      <ol className="grid gap-2">
        {draft.shots.map((s, i) => (
          <li key={s.id} aria-label={`Shot ${i + 1}`} className="border-3 border-line p-2 bg-surface grid gap-2">
            <div className="flex items-center gap-2">
              <b className="font-pixel text-sm">{s.id}</b>
              <span className="text-xs text-subtle">{s.purpose}</span>
              <label className="ml-auto text-xs flex items-center gap-1">
                seconds
                <input aria-label={`Shot ${i + 1} seconds`} type="number" min={1} max={15} step={0.5} disabled={approved} value={s.durationSec}
                  onChange={(e) => shot(i, { durationSec: Number(e.target.value) })} className="field w-16 px-1 py-0.5" />
              </label>
            </div>
            {s.text.map((t, k) => (
              <label key={k}>
                <span className={label}>{t.role}</span>
                <input aria-label={`Shot ${i + 1} ${t.role}`} disabled={approved} value={t.value} onChange={(e) => text(i, k, e.target.value)} className={field} />
              </label>
            ))}
            <label>
              <span className={label}>What we see</span>
              <textarea aria-label={`Shot ${i + 1} visual`} rows={2} disabled={approved} value={s.visual.description}
                onChange={(e) => shot(i, { visual: { ...s.visual, description: e.target.value } })} className={field} />
            </label>
            <label>
              <span className={label}>How it moves</span>
              <input aria-label={`Shot ${i + 1} motion`} disabled={approved} value={s.motion} onChange={(e) => shot(i, { motion: e.target.value })} className={field} />
            </label>
          </li>
        ))}
      </ol>

      {draft.assumptions.length > 0 && (
        <div>
          <p className={label}>The director assumed (not in your brief)</p>
          <ul className="list-disc pl-5 text-sm">{draft.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}

      {!approved && (
        <>
          <div className="flex flex-wrap gap-2">
            <button className="btn" disabled={busy || !dirty} onClick={() => onSave(draft)}>Save my edits</button>
            <button className="btn btn-primary" disabled={busy || dirty} onClick={() => onApprove(current.id)}
              title={dirty ? 'Save your edits first' : undefined}>Approve this plan</button>
          </div>
          <label>
            <span className={label}>Ask the director for a change</span>
            <textarea aria-label="Ask the director" rows={2} value={request} placeholder="buat shot 2 lebih singkat, ganti judul shot 3"
              onChange={(e) => setRequest(e.target.value)} className={field} />
          </label>
          <div>
            <button className="btn" disabled={busy || !request.trim() || dirty} onClick={() => { onRevise(request.trim()); setRequest(''); }}>Ask the director</button>
          </div>
        </>
      )}

      {plans.some((p) => p.changeRequest || p.changeSummary) && (
        <div>
          <p className={label}>Changes so far</p>
          <ul className="text-sm grid gap-1" aria-label="Revisions">
            {plans.filter((p) => p.changeRequest || p.changeSummary).map((p) => (
              <li key={p.id}>
                <b>Revision {p.revision}</b>
                {p.changeRequest && <> · you asked: “{p.changeRequest}”</>}
                {p.changeSummary && <> · {p.changeSummary}</>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
