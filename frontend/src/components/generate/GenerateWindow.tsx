'use client';

// Generate app: 2D videos from a brief. A brief becomes storylines, then a shot-by-shot plan you
// edit and approve; nothing is built from a plan that isn't approved. Without an LLM (or with a
// broken HyperFrames) the window says what to connect and links to Settings. Clipping never
// depends on this window.

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';
import type { GenCreateBody, GenEstimate, GenPlan, GenProject, GenProjectDetail, GenVerdict, GenerateStatus } from '@/types';
import { Window } from '../Window';
import { BriefForm, type PendingFile } from './BriefForm';
import { BuildPanel } from './BuildPanel';
import { DirectorLog } from './DirectorLog';
import { PlanEditor } from './PlanEditor';
import { VersionHistory } from './VersionHistory';
import { StorylineCards } from './StorylineCards';

const WORKING = ['RUNNING', 'BUILDING'];
const NEW = 'new';
const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

const nameOf = (p: GenProject) => p.title ?? (p.brief.length > 40 ? `${p.brief.slice(0, 40)}…` : p.brief);

export function GenerateWindow({ api, onOpenSettings, pollMs = 2000 }: { api: ApiClient; onOpenSettings: () => void; pollMs?: number }) {
  const [status, setStatus] = useState<GenerateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<GenProject[]>([]);
  const [selected, setSelected] = useState<string>(NEW);
  const [detail, setDetail] = useState<GenProjectDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<GenEstimate | null>(null);
  const [verdicts, setVerdicts] = useState<GenVerdict[]>([]);
  const [viewId, setViewId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getGenerateStatus().then(
      async (s) => {
        if (!live) return;
        setStatus(s);
        if (!s.available) return;
        try {
          const { projects: list } = await api.listGenerateProjects();
          if (!live) return;
          setProjects(list);
          if (list[0]) setSelected(list[0].id);
        } catch (e) {
          reportError(e, 'listGenerateProjects');
          if (live) setError((e as Error).message);
        }
      },
      (e) => { reportError(e, 'getGenerateStatus'); if (live) setError((e as Error).message); },
    );
    return () => { live = false; };
  }, [api]);

  const load = useCallback(async (id: string) => {
    try {
      const d = await api.getGenerateProject(id);
      setDetail(d);
      setProjects((list) => list.map((p) => (p.id === id ? d.project : p)));
    } catch (e) {
      reportError(e, 'getGenerateProject');
      setProblem((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    if (selected === NEW) { setDetail(null); return; }
    setDetail(null);
    load(selected);
  }, [selected, load]);

  // The director works in the background: the page follows along until it stops.
  useEffect(() => {
    if (!detail || !WORKING.includes(detail.project.status)) return;
    const t = setTimeout(() => load(detail.project.id), pollMs);
    return () => clearTimeout(t);
  }, [detail, pollMs, load]);

  // What a build will take, while a plan is approved and nothing is building.
  const projectId = detail?.project.id;
  const currentPlan = detail?.plans.find((x) => x.id === detail.project.currentPlanId) ?? detail?.plans[0];
  const buildable = !!currentPlan?.approvedAt && !WORKING.includes(detail?.project.status ?? '');
  const versionCount = detail?.versions.length ?? 0;
  useEffect(() => {
    if (!projectId || !buildable) { setEstimate(null); return; }
    let live = true;
    api.getGenerateEstimate(projectId).then((e) => { if (live) setEstimate(e); }, (e) => reportError(e, 'getGenerateEstimate'));
    return () => { live = false; };
  }, [api, projectId, buildable, versionCount]);

  // The two verdicts of the version on screen (the newest, or the one chosen in the history), once it is built.
  const newestId = detail?.versions[0]?.id ?? null;
  useEffect(() => { setViewId(null); }, [newestId, projectId]);
  const newest = detail?.versions.find((v) => v.id === viewId) ?? detail?.versions[0] ?? null;
  const shownId = newest?.status === 'BUILT' ? newest.id : null;
  useEffect(() => {
    if (!shownId) { setVerdicts([]); return; }
    let live = true;
    api.getGenerateVersion(shownId).then((r) => { if (live) setVerdicts(r.verdicts); }, (e) => { reportError(e, 'getGenerateVersion'); if (live) setProblem((e as Error).message); });
    return () => { live = false; };
  }, [api, shownId]);

  /** Runs one action, shows its error, and refreshes the open project. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      if (selected !== NEW) await load(selected);
    } catch (e) {
      setProblem((e as Error).message);
    }
    setBusy(false);
  };

  const create = (body: GenCreateBody, files: PendingFile[]) => act(async () => {
    const { project } = await api.createGenerateProject(body);
    setProjects((list) => [project, ...list]);
    setSelected(project.id);
    for (const f of files) await api.uploadGenerateAsset(project.id, f.file, f.kind);
  });

  if (error) return <Window title="Generate" bar="bg-sun"><p role="alert" className="text-error text-sm">{error}</p></Window>;
  if (!status) return <Window title="Generate" bar="bg-sun"><p className="text-sm text-subtle">Loading…</p></Window>;

  if (!status.available) {
    return (
      <Window title="Generate" bar="bg-sun" right="unavailable">
        <p className="text-sm text-fg/80 mb-3">Describe a video and Sorot plans it shot by shot, builds it with HyperFrames and checks it twice before you export.</p>
        <div role="status">
          <p className="text-sm font-semibold mb-1">Generate isn’t available yet</p>
          <ul className="list-disc pl-5 text-sm text-fg/80 mb-3">{status.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {!status.llm.configured && <button className="btn btn-primary" onClick={onOpenSettings}>Connect an LLM in Settings</button>}
        </div>
      </Window>
    );
  }

  const p = detail?.project;
  // The current plan first (a restore can make an older revision current), then the rest, newest first.
  const plans = currentPlan ? [currentPlan, ...(detail?.plans ?? []).filter((x) => x !== currentPlan)] : [];
  const approved = !!currentPlan?.approvedAt;

  return (
    <Window title="Generate" bar="bg-sun" right="ready">
      <p className="text-sm text-fg/80 mb-1">Describe a video and Sorot plans it shot by shot, builds it with HyperFrames and checks it twice before you export.</p>
      <p className="text-xs text-subtle mb-3" data-testid="generate-ready">
        Ready · HyperFrames {status.hyperframes.version} · rendering on the {status.compute.toUpperCase()}
      </p>

      <label className="block mb-3">
        <span className={label}>Video</span>
        <select aria-label="Project" value={selected} onChange={(e) => { setProblem(null); setSelected(e.target.value); }} className={field}>
          <option value={NEW}>New video</option>
          {projects.map((x) => <option key={x.id} value={x.id}>{nameOf(x)}</option>)}
        </select>
      </label>

      {problem && <p role="alert" className="text-error text-sm mb-2">{problem}</p>}

      {selected === NEW && <BriefForm busy={busy} onCreate={create} />}

      {selected !== NEW && !p && <p className="text-sm text-subtle">Loading…</p>}

      {p && (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="heading text-lg">{nameOf(p)}</h3>
            <span className="text-xs border-2 border-line px-1">{p.format} · {p.targetSec} s · {p.language}</span>
          </div>
          <p className="text-sm text-fg/80">{p.brief}</p>

          {p.status === 'RUNNING' && (
            <p role="status" className="text-sm font-semibold">
              {plans.length ? 'The director is working on the plan…' : p.storylines ? 'Writing the plan from your pick…' : 'Writing storylines…'}
            </p>
          )}

          {p.status === 'FAILED' && (
            <div role="alert" className="border-3 border-line p-2 bg-error-tint">
              <p className="text-sm font-semibold">That didn’t work: {p.errorMessage}</p>
              <p className="text-xs mb-2">Everything saved so far is kept. Retry picks up at the step that failed.</p>
              <button className="btn" disabled={busy} onClick={() => act(() => api.retryGenerateProject(p.id))}>Retry</button>
            </div>
          )}

          {plans.length === 0 && p.storylines && !WORKING.includes(p.status) && (
            <StorylineCards storylines={p.storylines} picked={p.pickedStoryline} busy={busy}
              onPick={(i, note) => act(() => api.pickStoryline(p.id, i, note))}
              onMore={(note) => act(() => api.newStorylines(p.id, note))} />
          )}

          {plans.length > 0 && (
            <PlanEditor plans={plans} targetSec={p.targetSec} busy={busy || WORKING.includes(p.status)}
              onSave={(plan: GenPlan) => act(() => api.saveGeneratePlan(p.id, plan))}
              onRevise={(request) => act(() => api.reviseGeneratePlan(p.id, request))}
              onApprove={(planId) => act(() => api.approveGeneratePlan(p.id, planId))} />
          )}

          {approved && <p className="text-sm font-semibold" role="status">Plan approved. It is locked: a change makes a new revision that needs approving again.</p>}

          {notice && <p role="status" className="text-sm font-semibold">{notice}</p>}

          {approved && (
            <BuildPanel api={api} project={p} version={newest} verdicts={verdicts} estimate={estimate} busy={busy} exported={detail?.exports.find((x) => x.versionId === newest?.id) ?? null} shots={currentPlan?.plan.shots.map((s) => s.id) ?? []}
              onBuild={() => act(() => api.startGenerateBuild(p.id))}
              onCancel={(id) => act(() => api.cancelGenerateVersion(id))}
              onAccept={(id) => act(() => api.acceptGenerateVersion(id))}
              onExport={(id) => act(async () => { await api.exportGenerateVersion(id); })}
              onFix={(id, body) => act(async () => {
                const r = await api.fixGenerateVersion(id, body);
                setNotice(r.needsApproval ? `${r.summary}. The plan's words or timing changed, so it needs your approval again before anything is built.` : null);
              })} />
          )}

          {approved && detail && (
            <VersionHistory versions={detail.versions} statuses={detail.verdictStatuses} shownId={shownId} currentPlanId={p.currentPlanId} busy={busy}
              onView={setViewId} onRestore={(id) => act(() => api.restoreGenerateVersion(id))} />
          )}

          {detail && detail.assets.length > 0 && (
            <div>
              <p className={label}>Your files</p>
              <ul className="text-sm grid gap-1">
                {detail.assets.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span>{a.kind}: {a.path.replace(/^assets\/[0-9a-f]{8}-/, '')}</span>
                    <button className="btn" disabled={busy} aria-label={`Remove ${a.path}`} onClick={() => act(() => api.deleteGenerateAsset(a.id))}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <DirectorLog api={api} projectId={p.id} version={p.updatedAt} />
            <button className="btn" disabled={busy || WORKING.includes(p.status)} onClick={() => {
              if (!window.confirm('Delete this video and its files?')) return;
              act(async () => {
                await api.deleteGenerateProject(p.id);
                setProjects((list) => list.filter((x) => x.id !== p.id));
                setSelected(NEW);
              });
            }}>Delete this video</button>
          </div>
        </div>
      )}
    </Window>
  );
}
