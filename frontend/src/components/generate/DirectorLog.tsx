'use client';

// The local director log: every call the director made for this project, newest first. It stays
// on this machine and holds no secrets.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';
import type { GenEvent } from '@/types';

export function DirectorLog({ api, projectId, version }: {
  api: ApiClient;
  projectId: string;
  /** Changes when the project does, so an open log reloads. */
  version: string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<GenEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.getGenerateEvents(projectId).then(
      (r) => { if (live) setEvents(r.events); },
      (e) => { reportError(e, 'getGenerateEvents'); if (live) setError((e as Error).message); },
    );
    return () => { live = false; };
  }, [api, projectId, open, version]);

  return (
    <div>
      <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide director log' : 'Show director log'}</button>
      {open && (
        <div className="mt-2" aria-label="Director log">
          {error && <p role="alert" className="text-error text-sm">{error}</p>}
          {!error && events === null && <p className="text-sm text-subtle">Loading…</p>}
          {events?.length === 0 && <p className="text-sm text-subtle">Nothing yet.</p>}
          <ul className="grid gap-1">
            {events?.map((e) => (
              <li key={e.id}>
                <details>
                  <summary className="text-sm cursor-pointer">
                    <b>{e.kind}</b> · {e.ok ? 'ok' : 'failed'}{e.ms !== null && ` · ${(e.ms / 1000).toFixed(1)} s`}{e.model && ` · ${e.model}`}
                  </summary>
                  {e.request && <pre className="text-xs whitespace-pre-wrap max-h-48 overflow-auto border-2 border-line p-1 my-1">{e.request}</pre>}
                  {e.response && <pre className="text-xs whitespace-pre-wrap max-h-48 overflow-auto border-2 border-line p-1 my-1">{e.response}</pre>}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
