'use client';

// Building a draft from the approved plan: start it (with a time estimate), follow its progress,
// cancel it, then watch the result next to its two verdicts and accept it.

import { useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { GenEstimate, GenFixBody, GenProject, GenVerdict, GenVersion } from '@/types';
import { VerdictPanel } from './VerdictPanel';

const STEP: Record<string, string> = {
  author: 'Writing the scenes', check: 'Checking them', render: 'Rendering the video', technical: 'Measuring it', creative: 'Judging it',
};

/** "about 30 s" / "about 10 min". */
export const aboutTime = (sec: number) => `about ${sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`}`;

const field = 'field w-full px-2 py-1.5';

export function BuildPanel({ api, project, version, verdicts, estimate, busy, shots, onBuild, onCancel, onAccept, onFix }: {
  api: ApiClient;
  project: GenProject;
  /** The newest version, if any. */
  version: GenVersion | null;
  verdicts: GenVerdict[];
  estimate: GenEstimate | null;
  busy: boolean;
  /** The plan's shot ids, for aiming a note at one shot. */
  shots: string[];
  onBuild: () => void;
  onCancel: (versionId: string) => void;
  onAccept: (versionId: string) => void;
  /** Ask the director to fix findings, or to change something, in a new version. */
  onFix: (versionId: string, body: GenFixBody) => void;
}) {
  const [note, setNote] = useState('');
  const [shot, setShot] = useState('');
  const working = version && (version.status === 'QUEUED' || version.status === 'BUILDING');
  const technicalFails = verdicts.some((v) => v.kind === 'TECHNICAL' && v.status === 'FAIL');
  const accepted = project.status === 'ACCEPTED';
  const mustFix = verdicts.flatMap((v) => v.findings).filter((f) => f.severity === 'must-fix' && f.state === 'open');

  return (
    <section aria-label="Build" className="grid gap-3">
      {!working && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={onBuild}>{version ? 'Build again' : 'Build a draft'}</button>
          {estimate && <span className="text-xs text-subtle">{aboutTime(estimate.draftSec)}</span>}
        </div>
      )}

      {working && version && (
        <div>
          <p className="text-sm font-semibold" role="status">
            {version.status === 'QUEUED' ? 'Waiting in the queue…' : `${STEP[version.step ?? ''] ?? 'Building'}…`}
          </p>
          <div className="border-3 border-line h-4 bg-surface my-1" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={version.progress ?? 0}>
            <div className="h-full bg-sun" style={{ width: `${version.progress ?? 0}%` }} />
          </div>
          <button className="btn" disabled={busy} onClick={() => onCancel(version.id)}>Cancel the build</button>
        </div>
      )}

      {version?.status === 'FAILED' && (
        <p role="alert" className="text-error text-sm">The build stopped: {version.errorMessage}. The scenes already written are kept.</p>
      )}
      {version?.status === 'CANCELLED' && <p className="text-sm text-subtle">The last build was cancelled.</p>}

      {version?.status === 'BUILT' && (
        <div className="grid gap-3">
          <p className="text-sm">Version {version.number} · {version.renderKind === 'final' ? 'final' : 'draft'} render</p>
          {version.draftPath && (
            <video aria-label="Draft video" controls src={api.generateDraftUrl(version.id)}
              className={`border-3 border-line bg-black ${project.format === '9:16' ? 'max-h-[480px]' : 'max-w-full'}`} />
          )}
          <VerdictPanel verdicts={verdicts} onFix={(id) => onFix(version.id, { findingIds: [id], ...(note.trim() ? { note: note.trim() } : {}), ...(shot ? { shotId: shot } : {}) })} />
          <div className="grid gap-2" aria-label="Fix">
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn" disabled={busy || !mustFix.length} onClick={() => onFix(version.id, {})}>Fix the must-fix items ({mustFix.length})</button>
              <span className="text-xs text-subtle">Each fix is a new version; this one stays.</span>
            </div>
            <label>
              <span className="font-pixel text-xs text-fg block mb-1">Or tell the director what to change</span>
              <textarea aria-label="Note for the fix" rows={2} value={note} placeholder="judul di shot 2 lebih besar, gerakan lebih lambat" onChange={(e) => setNote(e.target.value)} className={field} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Only this shot" value={shot} onChange={(e) => setShot(e.target.value)} className="field px-2 py-1.5">
                <option value="">Any shot</option>
                {shots.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <button className="btn" disabled={busy || !note.trim()} onClick={() => { onFix(version.id, { note: note.trim(), ...(shot ? { shotId: shot } : {}) }); setNote(''); }}>Fix with this note</button>
            </div>
          </div>
          {accepted ? (
            <p className="text-sm font-semibold" role="status">Accepted ✓</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" disabled={busy || technicalFails} onClick={() => onAccept(version.id)}>Accept this version</button>
              {technicalFails && <span className="text-xs text-error">TECHNICAL failed: fix the must-fix findings first.</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
