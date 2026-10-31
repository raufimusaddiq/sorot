'use client';

// The Library's "Generated" group: the finished videos of Generate, each playable, downloadable and
// publishable through the same Tebar panel as a clip.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { GenExport } from '@/types';
import { PublishPanel } from './PublishPanel';

export function GeneratedLibrary({ api }: { api: ApiClient }) {
  const [exports, setExports] = useState<GenExport[]>([]);
  const [publishing, setPublishing] = useState<GenExport | null>(null);

  useEffect(() => {
    api.generateExports().then((r) => setExports(r.exports), () => {});   // Generate off or unreachable: no group
  }, [api]);

  if (exports.length === 0) return null;
  return (
    <section aria-label="Generated videos" className="mt-8">
      <h2 className="heading text-[28px] mb-5">Generated ({exports.length})</h2>
      <ul className="space-y-4">
        {exports.map((e) => (
          <li key={e.id} className="rounded-card border-3 border-line shadow-hard-sm bg-surface-2 p-4 flex flex-wrap gap-4">
            <video aria-label={`Video ${e.title ?? e.id}`} controls preload="none" src={api.generateExportUrl(e.id)}
              className={`border-3 border-line bg-black ${e.format === '16:9' ? 'max-w-xs' : 'max-h-64'}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{e.title ?? 'Untitled'}</p>
              <p className="text-xs text-subtle">{e.projectTitle} · {e.format} · {e.durationSec} s</p>
              {e.description && <p className="text-xs text-muted mt-1">{e.description}</p>}
              <div className="flex gap-2 mt-2">
                <a className="btn" href={api.generateExportUrl(e.id, true)} download>Download</a>
                <button className="btn btn-primary" onClick={() => setPublishing(e)}>Publish</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {publishing && <PublishPanel generated={publishing} api={api} onClose={() => setPublishing(null)} />}
    </section>
  );
}
