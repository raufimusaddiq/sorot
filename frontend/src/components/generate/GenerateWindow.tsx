'use client';

// Generate app: 2D videos from a brief. For now it shows whether Generate can run here; without
// an LLM (or with a broken HyperFrames) it says what to connect and links to Settings. Clipping
// never depends on this window.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';
import type { GenerateStatus } from '@/types';
import { Window } from '../Window';

export function GenerateWindow({ api, onOpenSettings }: { api: ApiClient; onOpenSettings: () => void }) {
  const [status, setStatus] = useState<GenerateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getGenerateStatus().then(
      (s) => { if (live) setStatus(s); },
      (e) => { reportError(e, 'getGenerateStatus'); if (live) setError((e as Error).message); },
    );
    return () => { live = false; };
  }, [api]);

  if (error) return <Window title="Generate" bar="bg-sun"><p role="alert" className="text-error text-sm">{error}</p></Window>;
  if (!status) return <Window title="Generate" bar="bg-sun"><p className="text-sm text-subtle">Loading…</p></Window>;

  return (
    <Window title="Generate" bar="bg-sun" right={status.available ? 'ready' : 'unavailable'}>
      <p className="text-sm text-fg/80 mb-3">
        Describe a video and Sorot plans it shot by shot, builds it with HyperFrames and checks it twice before you export.
      </p>
      {status.available ? (
        <p className="text-sm" data-testid="generate-ready">
          Ready · HyperFrames {status.hyperframes.version} · rendering on the {status.compute.toUpperCase()}
        </p>
      ) : (
        <div role="status">
          <p className="text-sm font-semibold mb-1">Generate isn’t available yet</p>
          <ul className="list-disc pl-5 text-sm text-fg/80 mb-3">
            {status.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
          {!status.llm.configured && (
            <button className="btn btn-primary" onClick={onOpenSettings}>Connect an LLM in Settings</button>
          )}
        </div>
      )}
    </Window>
  );
}
