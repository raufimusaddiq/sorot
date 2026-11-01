'use client';

// The facts of a video: each claim with the page that states it. Check them against their sources
// and see what was found: verified, corrected (with the value it had before), or not verifiable.
// A factual recipe lets the video show only numbers that a verified fact states.

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { GenFact } from '@/types';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';
const BADGE: Record<GenFact['status'], string> = { verified: 'bg-mint', corrected: 'bg-sun', unverified: 'bg-surface-3', unverifiable: 'bg-hot text-white' };
const WORD: Record<GenFact['status'], string> = { verified: 'verified', corrected: 'corrected', unverified: 'not checked', unverifiable: 'unverifiable' };

function FactRow({ fact, busy, onSave, onDelete }: { fact: GenFact; busy: boolean; onSave: (id: string, body: { claim: string; value: string; sourceUrl: string }) => void; onDelete: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [claim, setClaim] = useState(fact.claim);
  const [value, setValue] = useState(fact.value ?? '');
  const [url, setUrl] = useState(fact.sourceUrl ?? '');
  return (
    <li className="border-2 border-line bg-surface p-2">
      {editing ? (
        <div className="grid gap-2">
          <input aria-label="Claim" value={claim} onChange={(e) => setClaim(e.target.value)} className={field} />
          <input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} className={field} />
          <input aria-label="Source address" value={url} onChange={(e) => setUrl(e.target.value)} className={field} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !claim.trim()} onClick={() => { onSave(fact.id, { claim, value, sourceUrl: url }); setEditing(false); }}>Save</button>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs border-2 border-line px-1 ${BADGE[fact.status]}`}>{WORD[fact.status]}</span>
            <b className="text-sm">{fact.claim}</b>
            {fact.value && <span className="text-sm">({fact.value})</span>}
            {fact.addedBy !== 'owner' && <span className="text-xs text-subtle">added by {fact.addedBy}</span>}
            <span className="ml-auto flex gap-1">
              <button className="btn" aria-label={`Edit ${fact.claim}`} onClick={() => setEditing(true)}>Edit</button>
              <button className="btn" aria-label={`Delete ${fact.claim}`} disabled={busy} onClick={() => onDelete(fact.id)}>✕</button>
            </span>
          </div>
          {fact.originalValue && <p className="text-xs text-subtle">Was: {fact.originalValue}</p>}
          {fact.sourceUrl && (
            <p className="text-xs break-all">
              Source: {fact.sourceUrl.startsWith('http') ? <a href={fact.sourceUrl} target="_blank" rel="noreferrer" className="underline">{fact.sourceUrl}</a> : fact.sourceUrl}
            </p>
          )}
          {fact.evidence && <p className="text-xs text-muted">{fact.status === 'unverifiable' ? 'Why: ' : 'Evidence: '}&ldquo;{fact.evidence}&rdquo;</p>}
        </>
      )}
    </li>
  );
}

export function FactsPanel({ api, projectId, busy: parentBusy = false }: { api: ApiClient; projectId: string; busy?: boolean }) {
  const [facts, setFacts] = useState<GenFact[] | null>(null);
  const [claim, setClaim] = useState('');
  const [value, setValue] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.listGenerateFacts(projectId).then((r) => setFacts(r.facts), (e) => setError((e as Error).message)), [api, projectId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const add = () => run(async () => {
    await api.addGenerateFact(projectId, { claim, ...(value.trim() ? { value } : {}), sourceUrl: url });
    setClaim('');
    setValue('');
    setUrl('');
  });

  if (facts === null) return error ? <p role="alert" className="text-error text-sm">{error}</p> : null;
  const unchecked = facts.filter((f) => f.status === 'unverified').length;
  return (
    <section aria-label="Facts" className="grid gap-2">
      <h3 className="heading text-base">Facts</h3>
      <p className="text-xs text-subtle">Each fact is checked against the page you name; only a passage that is really on that page counts. A recipe for factual videos lets the video show only numbers that a verified fact states.</p>
      {facts.length === 0 && <p className="text-sm">No facts yet.</p>}
      <ul className="grid gap-2">
        {facts.map((f) => (
          <FactRow key={f.id} fact={f} busy={busy || parentBusy} onSave={(id, body) => run(() => api.updateGenerateFact(id, body))} onDelete={(id) => run(() => api.deleteGenerateFact(id))} />
        ))}
      </ul>
      <div>
        <button className="btn" disabled={busy || parentBusy || facts.length === 0} onClick={() => run(() => api.verifyGenerateFacts(projectId))}>
          {busy ? 'Working…' : unchecked ? `Check ${unchecked} against their sources` : 'Check again against the sources'}
        </button>
      </div>
      <div className="grid gap-2 border-t-2 border-line pt-2">
        <span className={label}>Add a fact</span>
        <input aria-label="New claim" value={claim} placeholder="Suku bunga acuan BI adalah 5,75 persen" onChange={(e) => setClaim(e.target.value)} className={field} />
        <div className="grid sm:grid-cols-2 gap-2">
          <input aria-label="New value" value={value} placeholder="5,75%" onChange={(e) => setValue(e.target.value)} className={field} />
          <input aria-label="New source address" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} className={field} />
        </div>
        <div><button className="btn" disabled={busy || !claim.trim() || !url.trim()} onClick={add}>Add fact</button></div>
      </div>
      {error && <p role="alert" className="text-error text-sm">{error}</p>}
    </section>
  );
}
