'use client';

// Settings → Generate → Kit: the drawing and motion parts directors build with. Built-in parts come
// with Sorot; your own are added from a .zip, checked (their example renders twice and must come out
// the same) and can be exported or removed. Recipes only name parts; they never carry part code.

import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { GenKitPart } from '@/types';
import { Window } from '../Window';

export function KitPanel({ api }: { api: ApiClient }) {
  const [parts, setParts] = useState<GenKitPart[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = () => api.kitParts().then((r) => setParts(r.parts), (e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(await work());
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const add = (f: File) => run(async () => {
    const { part } = await api.addKitPart(f);
    return `Added ${part.name} ${part.version}: directors are offered it from their next call.`;
  });
  const remove = (name: string) => {
    if (!window.confirm(`Remove your part ${name}? A recipe that names it shows as unavailable until it is added again.`)) return;
    run(async () => { await api.removeKitPart(name); return `Removed ${name}.`; });
  };

  return (
    <Window title="Kit" bar="bg-sun" right={parts ? `${parts.length} parts` : undefined}>
      <p className="text-sm text-fg/80 mb-2">
        Parts directors build scenes from. A part that wants a GPU still draws on a CPU, more slowly.
      </p>
      {parts && (
        <ul aria-label="Kit parts" className="grid gap-2">
          {parts.map((p) => (
            <li key={p.name} className="border-2 border-line p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <b className="font-pixel">{p.name}</b>
                <span className="text-xs text-subtle">{p.version} · {p.manifest.runtime}{p.manifest.needs.gpu === 'no' ? '' : ` · GPU ${p.manifest.needs.gpu}`}</span>
                <span className="text-xs border-2 border-line px-1">{p.source === 'builtIn' ? 'built in' : 'yours'}</span>
                <a className="ml-auto text-xs underline" href={api.kitPartExportUrl(p.name)} download>Export</a>
                {p.source === 'user' && <button className="btn text-xs" disabled={busy} onClick={() => remove(p.name)}>Remove {p.name}</button>}
              </div>
              <p className="text-xs mt-1">{p.manifest.does}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <input ref={file} aria-label="Kit part .zip" type="file" accept=".zip,application/zip" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) add(f); e.target.value = ''; }} />
        <button className="btn" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Checking the part…' : 'Add a part (.zip)'}</button>
      </div>
      {note && <p role="status" className="text-success text-sm mt-2">{note}</p>}
      {error && <p role="alert" className="text-error text-sm mt-2">{error}</p>}
    </Window>
  );
}
