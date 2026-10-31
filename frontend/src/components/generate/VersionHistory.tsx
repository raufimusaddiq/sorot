'use client';

// Every build of a video is kept as a version: view any of them with its two verdicts, or
// restore the plan it was built from. Old drafts are removed to save space; their verdicts stay.

import type { GenVerdictStatuses, GenVersion } from '@/types';

const BADGE = { PASS: 'bg-mint', REVIEW: 'bg-sun', FAIL: 'bg-hot text-white' } as const;
const WORD: Record<GenVersion['status'], string> = { QUEUED: 'waiting', BUILDING: 'building', BUILT: 'built', FAILED: 'failed', CANCELLED: 'cancelled' };

export function VersionHistory({ versions, statuses, shownId, currentPlanId, busy, onView, onRestore }: {
  /** Newest first. */
  versions: GenVersion[];
  statuses: GenVerdictStatuses;
  /** The version whose video and verdicts are on screen. */
  shownId: string | null;
  /** The plan the project builds from now. */
  currentPlanId: string | null;
  busy: boolean;
  onView: (versionId: string) => void;
  onRestore: (versionId: string) => void;
}) {
  if (versions.length < 2) return null;
  return (
    <section aria-label="Versions">
      <h3 className="heading text-base mb-1">Versions</h3>
      <ul className="grid gap-1">
        {versions.map((v) => {
          const s = statuses[v.id] ?? {};
          const parent = versions.find((x) => x.id === v.parentVersionId);
          const removed = v.status === 'BUILT' && !v.draftPath;
          return (
            <li key={v.id} className={`flex flex-wrap items-center gap-2 border-2 border-line px-2 py-1 ${v.id === shownId ? 'bg-surface-3' : ''}`}>
              <b className="text-sm">Version {v.number}</b>
              <span className="text-xs text-subtle">{WORD[v.status]}{parent ? ` · fixed from version ${parent.number}` : ''}</span>
              {(['TECHNICAL', 'CREATIVE'] as const).map((k) => s[k] && (
                <span key={k} className={`text-xs border-2 border-line px-1 ${BADGE[s[k]!]}`}>{k.toLowerCase()} {s[k]}</span>
              ))}
              {removed && <span className="text-xs text-subtle">video removed to save space</span>}
              {v.status === 'BUILT' && (
                <button className="btn ml-auto" disabled={busy || v.id === shownId} aria-label={`View version ${v.number}`} onClick={() => onView(v.id)}>
                  {v.id === shownId ? 'Showing' : 'View'}
                </button>
              )}
              {v.status === 'BUILT' && (
                <button className="btn" disabled={busy || v.planId === currentPlanId} aria-label={`Restore the plan of version ${v.number}`} onClick={() => onRestore(v.id)}>
                  {v.planId === currentPlanId ? 'Current plan' : 'Restore this plan'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
