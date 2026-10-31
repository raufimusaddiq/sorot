'use client';

// The two verdicts of a build, side by side. TECHNICAL is measured by code and a FAIL blocks the
// export; CREATIVE comes from a separate judge, guides the next fix and never blocks. Findings
// are ranked worst first with their shot and time; warnings kept on purpose are listed apart.

import type { GenFinding, GenVerdict } from '@/types';

const ORDER = { 'must-fix': 0, 'should-fix': 1, polish: 2 } as const;
const BADGE: Record<GenVerdict['status'], string> = { PASS: 'bg-mint', REVIEW: 'bg-sun', FAIL: 'bg-hot text-white' };
const ABOUT = {
  TECHNICAL: 'Measured by code: size, length, text, readability, sound. A FAIL blocks the export.',
  CREATIVE: 'A separate judge who only saw the brief, the plan and the result. It guides the next fix and never blocks.',
} as const;

/** "s02 · 4.2 to 5 s", "s02", "12 s" or nothing. */
export function where(f: Pick<GenFinding, 'shotId' | 'fromSec' | 'toSec'>): string {
  const time = f.fromSec === undefined ? '' : f.toSec === undefined ? `${f.fromSec} s` : `${f.fromSec} to ${f.toSec} s`;
  return [f.shotId, time].filter(Boolean).join(' · ');
}

function Card({ kind, verdict }: { kind: GenVerdict['kind']; verdict?: GenVerdict }) {
  const live = (verdict?.findings ?? []).filter((f) => f.state !== 'kept').sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const kept = (verdict?.findings ?? []).filter((f) => f.state === 'kept');
  return (
    <section aria-label={`${kind} verdict`} className="border-3 border-line p-3 bg-surface">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="heading text-base">{kind}</h3>
        {verdict ? <span className={`text-xs border-2 border-line px-1 ${BADGE[verdict.status]}`}>{verdict.status}</span> : <span className="text-xs text-subtle">not judged yet</span>}
      </div>
      <p className="text-xs text-subtle mb-2">{ABOUT[kind]}</p>
      {verdict && <p className="text-xs text-subtle mb-2">Judged by {verdict.judgedBy}.</p>}
      {verdict && live.length === 0 && <p className="text-sm">Nothing to fix.</p>}
      <ul className="grid gap-2">
        {live.map((f) => (
          <li key={f.id} className="text-sm">
            <span className="font-pixel text-xs border-2 border-line px-1 mr-1">{f.severity}</span>
            {where(f) && <span className="text-xs text-subtle mr-1">{where(f)}</span>}
            <span>{f.description}</span>
            {f.suggestedFix && <span className="block text-xs text-subtle">Fix: {f.suggestedFix}</span>}
          </li>
        ))}
      </ul>
      {kept.length > 0 && (
        <div className="mt-2">
          <p className="font-pixel text-xs">Kept on purpose</p>
          <ul className="text-xs text-subtle grid gap-1">
            {kept.map((f) => <li key={f.id}>{f.code}{f.shotId ? ` (${f.shotId})` : ''}: {f.keptReason ?? 'no reason given'}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

export function VerdictPanel({ verdicts }: { verdicts: GenVerdict[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Card kind="TECHNICAL" verdict={verdicts.find((v) => v.kind === 'TECHNICAL')} />
      <Card kind="CREATIVE" verdict={verdicts.find((v) => v.kind === 'CREATIVE')} />
    </div>
  );
}
