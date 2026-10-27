'use client';

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { ApiClient } from '@/lib/api';
import { reportError, onError, isAbortError } from '@/lib/errors';
import type {
  Video, Job, StageStatus, Clip, ClipScore,
  JobDetail, ClipDetail, VideoGroup, EditChoices,
} from '@/types';
import {
  STAGE_LABELS, STAGE_ORDER, STATUS_COLORS,
  formatTime, formatDuration, formatDurationSec, timeAgo, tierLabel, videoLabel,
} from '@/lib/ui-utils';
import { ProgressBar, ScoreBadge, TranscriptView } from '@/components/progress';
import { FALLBACK_CHOICES, ImportOptions, type ImportSettings } from '@/components/ImportOptions';
import { ClipEditor } from '@/components/ClipEditor';
import { Window } from '@/components/Window';
import { Dock, ICONS, MenuBar } from '@/components/Desktop';

// Adaptive polling bounds for job status — start fast so stage transitions
// feel snappy, back off so a 6-min RENDER stage doesn't fire 180 requests.
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 10000;

/** Tier sticker fills (black text on loud colour). */
const TIER_STICKERS: Record<string, string> = {
  PRIMARY: 'bg-mint',
  BACKUP: 'bg-sun',
  SKIP: 'bg-surface-3',
};

// Kept-in-file components: ClipCard + DiscoveryPanel are deeply coupled to
// Home's state and refresh handlers; their extraction is a separate PR.

function ClipCard({
  clip, score, previewing, onPreview, onExport, onEdit, api,
  selectable, selected, onSelect,
}: {
  clip: Clip; score?: ClipScore; previewing: boolean;
  onPreview: () => void; onExport: () => void; onEdit: () => void; api: ApiClient;
  selectable?: boolean; selected?: boolean; onSelect?: () => void;
}) {
  const [showScore, setShowScore] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [feedback, setFeedback] = useState({
    views: '', likes: '', comments: '', shares: '', saves: '',
    // datetime-local format (yyyy-MM-ddTHH:mm) in the browser's local tz;
    // converted to ISO-8601 UTC on submit.
    postedAt: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [viralScore, setViralScore] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleSubmitFeedback = async () => {
    setFeedbackError(null);
    if (!feedback.postedAt) {
      setFeedbackError('Isi tanggal upload dulu — viral score butuh durasi di platform.');
      return;
    }
    const postedDate = new Date(feedback.postedAt);
    if (Number.isNaN(postedDate.getTime())) {
      setFeedbackError('Format tanggal tidak valid.');
      return;
    }
    if (postedDate.getTime() > Date.now()) {
      setFeedbackError('Tanggal upload tidak boleh di masa depan.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.submitFeedback(clip.id, {
        views: parseInt(feedback.views) || 0,
        likes: parseInt(feedback.likes) || 0,
        comments: parseInt(feedback.comments) || 0,
        shares: parseInt(feedback.shares) || 0,
        saves: parseInt(feedback.saves) || 0,
        postedAt: postedDate.toISOString(),
      });
      const data = result as { viralScore: number };
      setViralScore(data.viralScore);
    } catch (e) {
      setFeedbackError(e instanceof Error ? e.message : 'Gagal submit feedback');
      reportError(e, 'submitFeedback');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-clip-card className={`relative rounded-card border-3 border-line shadow-hard ${
      selected ? 'bg-accent-tint' : 'bg-surface'
    }`}>
      <span className={`sticker absolute -top-3 -right-2 z-10 rotate-6 ${TIER_STICKERS[clip.tier] || 'bg-surface-3'}`}>
        {tierLabel(clip.tier)}
      </span>
      <div className="p-4">
        <div className="flex items-end justify-between gap-2 mb-3 pr-20">
          <div className="flex items-center gap-2">
            {selectable && (
              <button
                onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
                className={`w-6 h-6 rounded flex items-center justify-center border-3 border-line flex-shrink-0 ${
                  selected ? 'bg-sun' : 'bg-surface-2'
                }`}
                aria-label="Select clip"
              >
                {selected && (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="square" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )}
            <span className="font-pixel text-lg text-fg">#{clip.rankPos || '-'}</span>
          </div>
          <div className="whitespace-nowrap leading-none" title="Score">
            <span className="heading text-3xl">{clip.score ? (clip.score * 100).toFixed(0) : '-'}</span>
            <span className="font-pixel text-xs text-muted">/100</span>
          </div>
        </div>
        {clip.title && (
          <p className="text-sm font-bold text-fg mb-1 line-clamp-2">{clip.title}</p>
        )}
        <div className="flex gap-3 font-pixel text-xs text-muted mb-3">
          <span>{formatTime(clip.startTime)} &#8594; {formatTime(clip.endTime)}</span>
          <span>&#8226;</span>
          <span>{formatDuration(clip.durationSec)}</span>
        </div>
        {clip.textContent && (
          <p className="text-xs text-fg/80 line-clamp-3 mb-4 bg-surface-2 border-2 border-line rounded p-2">{clip.textContent}</p>
        )}
        <div className="flex gap-2 flex-wrap">
          {clip.renderPath && (
            <button onClick={onPreview} className={`btn flex-1 ${previewing ? 'bg-accent text-white' : 'bg-aqua'}`}>
              {previewing ? 'Playing...' : 'Preview'}
            </button>
          )}
          {score && (
            <button onClick={() => setShowScore(!showScore)} className="btn flex-1">
              {showScore ? 'Hide' : 'Score'}
            </button>
          )}
          {(clip.title || clip.description) && (
            <button onClick={() => setShowMeta(!showMeta)} className="btn flex-1 bg-lilac">
              {showMeta ? 'Hide' : 'Copy'}
            </button>
          )}
          {clip.exportPath && (
            <a href={api.getExportUrl(clip.id, clip.updatedAt)} className="btn flex-1 bg-mint">Download</a>
          )}
          {!clip.exportPath && clip.renderStatus === 'COMPLETED' && (
            <button onClick={onExport} className="btn btn-primary flex-1">Export</button>
          )}
          <button onClick={onEdit} className="btn">
            Edit
          </button>
          <button onClick={() => setShowFeedback(!showFeedback)} className="btn text-muted">
            {viralScore !== null ? `${(viralScore * 100).toFixed(0)}%` : 'FB'}
          </button>
        </div>
      </div>
      {showMeta && (clip.title || clip.description) && (
        <div className="border-t-3 border-line px-4 py-3 space-y-2">
          {clip.title && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-subtle font-medium">Title</span>
                <button onClick={() => handleCopy(clip.title!, 'title')} className="font-pixel text-xs text-accent underline">
                  {copied === 'title' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-sm text-fg bg-surface-2 border-2 border-line rounded p-2">{clip.title}</p>
            </div>
          )}
          {clip.description && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-subtle font-medium">Description</span>
                <button onClick={() => handleCopy(clip.description!, 'desc')} className="font-pixel text-xs text-accent underline">
                  {copied === 'desc' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-sm text-fg/85 bg-surface-2 border-2 border-line rounded p-2 whitespace-pre-wrap">{clip.description}</p>
            </div>
          )}
        </div>
      )}
      {showFeedback && (
        <div className="border-t-3 border-line px-4 py-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted font-medium block">
              Tanggal & jam upload
              <span className="text-accent ml-1">*</span>
            </label>
            <input
              type="datetime-local"
              value={feedback.postedAt}
              onChange={e => setFeedback(f => ({ ...f, postedAt: e.target.value }))}
              max={new Date(Date.now() - 60000).toISOString().slice(0, 16)}
              className="field px-2 py-1.5 text-xs w-full"
            />
            <p className="text-xs text-subtle">
              Viral score dihitung per-hari (velocity), jadi durasi di platform wajib diisi.
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted font-medium block">Metrik saat ini</span>
            <div className="grid grid-cols-5 gap-1">
              <input type="number" placeholder="Views" value={feedback.views} onChange={e => setFeedback(f => ({...f, views: e.target.value}))}
                className="field px-2 py-1 text-xs w-full" />
              <input type="number" placeholder="Likes" value={feedback.likes} onChange={e => setFeedback(f => ({...f, likes: e.target.value}))}
                className="field px-2 py-1 text-xs w-full" />
              <input type="number" placeholder="Comments" value={feedback.comments} onChange={e => setFeedback(f => ({...f, comments: e.target.value}))}
                className="field px-2 py-1 text-xs w-full" />
              <input type="number" placeholder="Shares" value={feedback.shares} onChange={e => setFeedback(f => ({...f, shares: e.target.value}))}
                className="field px-2 py-1 text-xs w-full" />
              <input type="number" placeholder="Saves" value={feedback.saves} onChange={e => setFeedback(f => ({...f, saves: e.target.value}))}
                className="field px-2 py-1 text-xs w-full" />
            </div>
          </div>
          {feedbackError && (
            <p className="text-xs text-fg font-semibold bg-error-tint border-2 border-line rounded px-2 py-1">
              {feedbackError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button onClick={handleSubmitFeedback} disabled={submitting}
              className="btn btn-primary">
              {submitting ? 'Saving...' : 'Submit feedback'}
            </button>
            {viralScore !== null && (
              <span className="text-xs font-pixel text-success">
                Viral Score: {(viralScore * 100).toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      )}
      {showScore && score && (
        <div className="border-t-3 border-line px-4 py-3 space-y-1">
          <ScoreBadge score={score.hookStrength} label="Hook" />
          <ScoreBadge score={score.keywordTrigger} label="Keywords" />
          <ScoreBadge score={score.novelty} label="Novelty" />
          <ScoreBadge score={score.clarity} label="Clarity" />
          <ScoreBadge score={score.emotionalEnergy} label="Energy" />
          <ScoreBadge score={score.textSentiment} label="Sentiment" />
          <ScoreBadge score={score.pauseStructure} label="Pauses" />
          <ScoreBadge score={score.facePresence} label="Face" />
          <ScoreBadge score={score.sceneChange} label="Scenes" />
          <ScoreBadge score={score.topicFit} label="Topic Fit" />
          <div className="border-t-2 border-line pt-1 mt-1">
            <div className="flex justify-between text-xs">
              <span className="text-success">Boost +{(score.boostTotal * 100).toFixed(0)}%</span>
              <span className="text-error">Penalty -{(score.penaltyTotal * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type DiscoveredVideo = {
  id: string;              // persisted row id
  youtubeId: string;
  videoId: string;         // legacy alias = youtubeId
  title: string;
  url: string;
  duration: number;
  channel: string;
  viewCount: number | null;
  uploadDate: string;
  relevanceScore: number;
  transcriptScore: number | null;
  predictedScore: number | null;
  status: 'NEW' | 'QUEUED' | 'IMPORTED' | 'SKIPPED' | 'FAILED';
  jobId: string | null;
  sourceMode: string;
  sourceQuery: string;
  /** Auto-discover picks: the LLM's model name, or "algorithm". */
  pickedBy?: string | null;
  /** Plain-language reasons behind the rank (agent reason, strong moments, speech, channel…). */
  why?: string[];
};

type AutoStep = { tool: string; args: Record<string, unknown>; result: string };
type AutoRun = {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  mode: 'agent' | 'algorithm' | null;
  model: string | null;
  steps: AutoStep[];
  notes: string | null;
  llmError: string | null;
  error: string | null;
  count: number;
};

const AUTO_POLL_MS = 2000;

type DiscoveryMode = 'auto' | 'search' | 'trending' | 'channel';
type MainTab = 'import' | 'discovery' | 'learning';
type TabKey = 'clips' | 'transcript';

function DiscoveryPanel({ api }: { api: ApiClient }) {
  const [mode, setMode] = useState<DiscoveryMode>('auto');
  const [goal, setGoal] = useState('');
  const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
  const [query, setQuery] = useState('');
  const [channelUrl, setChannelUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DiscoveredVideo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'ACTIVE' | 'NEW' | 'QUEUED' | 'IMPORTED' | 'SKIPPED'>('ACTIVE');
  const [draining, setDraining] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listCandidates(filter === 'ACTIVE' ? undefined : filter) as { videos: DiscoveredVideo[] };
      setCandidates(data.videos || []);
    } catch (e) { reportError(e, 'discover.listCandidates'); }
  }, [api, filter]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while enrichment is in flight (any NEW row lacking transcriptScore).
  useEffect(() => {
    const pending = candidates.some(c => c.status === 'NEW' && c.transcriptScore === null);
    if (!pending) return;
    const t = setTimeout(() => { void refresh(); }, 3000);
    return () => clearTimeout(t);
  }, [candidates, refresh]);

  // Follow a running auto-discover until it finishes, then show its picks.
  useEffect(() => {
    if (autoRun?.status !== 'RUNNING') return;
    const t = setTimeout(async () => {
      try {
        const next = await api.discoverAutoStatus(autoRun.id) as AutoRun;
        setAutoRun(next);
        if (next.status === 'DONE') await refresh();
        if (next.status === 'FAILED') setError(next.error || 'Auto-discover failed');
      } catch (e) { reportError(e, 'discover.autoStatus'); }
    }, AUTO_POLL_MS);
    return () => clearTimeout(t);
  }, [api, autoRun, refresh]);

  const handleSearch = async () => {
    if (mode === 'auto') {
      setError(null);
      try {
        setAutoRun(await api.discoverAuto(goal.trim()) as AutoRun);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Auto-discover failed');
      }
      return;
    }
    if (mode === 'search' && !query.trim()) return;
    if (mode === 'channel' && !channelUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (mode === 'search') await api.discoverSearch(query.trim());
      else if (mode === 'trending') await api.discoverTrending();
      else await api.discoverChannel(channelUrl.trim());
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const handleQueueSelected = async () => {
    if (selected.size === 0) return;
    try {
      await api.queueCandidates(Array.from(selected));
      setSelected(new Set());
      await refresh();
    } catch (e) { reportError(e, 'discover.queue'); }
  };

  const handleDrain = async () => {
    setDraining(true);
    try {
      await api.drainCandidateQueue();
      await refresh();
    } catch (e) { reportError(e, 'discover.drain'); }
    finally { setDraining(false); }
  };

  const handleSkip = async (id: string) => {
    try {
      await api.updateCandidateStatus(id, 'SKIPPED');
      await refresh();
    } catch (e) { reportError(e, 'discover.skip'); }
  };

  const handleUnskip = async (id: string) => {
    try {
      await api.updateCandidateStatus(id, 'NEW');
      await refresh();
    } catch (e) { reportError(e, 'discover.unskip'); }
  };

  const queuedCount = candidates.filter(c => c.status === 'QUEUED').length;
  const newCount = candidates.filter(c => c.status === 'NEW').length;

  return (
    <div className="space-y-8">
      <Window title="Discover" bar="bg-lilac" right={autoRun?.status === 'RUNNING' ? 'researching…' : undefined}>
        <div className="flex gap-2 mb-4 flex-wrap">
          {(['auto', 'search', 'trending', 'channel'] as DiscoveryMode[]).map(m => (
            <button key={m} onClick={() => setMode(m)} className={`btn text-sm ${
              mode === m ? 'bg-accent text-white' : ''
            }`}>{m === 'auto' ? '✨ Auto' : m.charAt(0).toUpperCase() + m.slice(1)}</button>
          ))}
        </div>

        <div className="flex gap-3 flex-col sm:flex-row">
          {mode === 'auto' && (
            <input type="text" value={goal} onChange={e => setGoal(e.target.value)}
              placeholder="Optional focus (e.g. drama artis, politik, podcast bisnis)…"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="field flex-1" />
          )}
          {mode === 'search' && (
            <input type="text" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search keywords (e.g. rahasia penting indonesia)…"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="field flex-1" />
          )}
          {mode === 'channel' && (
            <input type="text" value={channelUrl} onChange={e => setChannelUrl(e.target.value)}
              placeholder="YouTube channel URL (e.g. https://youtube.com/@channel)"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="field flex-1" />
          )}
          {mode === 'trending' && (
            <div className="flex-1 text-sm text-muted py-2">Fetches current Indonesian trending videos</div>
          )}
          <button onClick={handleSearch} disabled={loading || (mode === 'auto' && autoRun?.status === 'RUNNING')}
            className="btn btn-primary px-6 py-2 text-sm whitespace-nowrap">
            {loading ? 'Searching…' : mode !== 'auto' ? 'Discover' : autoRun?.status === 'RUNNING' ? 'Researching…' : 'Auto-discover'}
          </button>
        </div>
        {error && <p className="text-error text-xs font-semibold mt-2">{error}</p>}
        {mode === 'auto' && autoRun && (
          <div className="mt-4 text-xs space-y-1" data-testid="auto-run">
            {autoRun.status === 'DONE' && (
              <p className="text-fg font-semibold">
                {autoRun.mode === 'agent' ? `Picked ${autoRun.count} by ${autoRun.model}` : `Picked ${autoRun.count} by the algorithm`}
                {autoRun.mode === 'algorithm' && autoRun.llmError && <span className="text-muted font-normal"> — {autoRun.llmError}</span>}
              </p>
            )}
            {autoRun.notes && <p className="text-muted">Trend: {autoRun.notes}</p>}
            {autoRun.steps.length > 0 && (
              <ul className="font-pixel bg-[#1D2B1D] text-[#9CFF9C] border-3 border-line rounded-md px-3 py-2 space-y-0.5">
                {autoRun.steps.slice(-8).map((s, i) => (
                  <li key={i}>{s.tool} {String(s.args.query ?? s.args.video_id ?? s.args.channel ?? '')} → {s.result}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="text-xs text-muted mt-4">
          {mode === 'auto'
            ? 'Auto researches what is trending (web + YouTube), reads the whole captions of promising videos and picks the ones worth clipping, with a reason for each. It uses the LLM when one is configured, otherwise the algorithm.'
            : <>Results persist across refreshes. Top candidates are scored from their whole captions in the background —
              check back in a few seconds for a <span className="font-pixel text-accent">predicted</span> score that reflects the
              actual video content, not just the title.</>}
        </p>
      </Window>

      <Window title="Candidates" bar="bg-aqua" right={`${candidates.length} found`} bodyClassName="">
        {/* Toolbar */}
        <div className="flex items-center gap-2 flex-wrap px-4 py-3 border-b-3 border-line">
          <div className="flex gap-1 flex-wrap">
            {(['ACTIVE', 'NEW', 'QUEUED', 'IMPORTED', 'SKIPPED'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-2.5 py-0.5 rounded-full border-2 border-line text-xs font-semibold ${
                  filter === f ? 'bg-fg text-sun' : 'bg-surface-2 text-fg hover:bg-surface-3'
                }`}>
                {f === 'ACTIVE' ? `All (${newCount + queuedCount})` : f}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {selected.size > 0 && (
            <button onClick={handleQueueSelected} className="btn bg-accent text-white">
              Queue {selected.size} selected
            </button>
          )}
          {queuedCount > 0 && (
            <button onClick={handleDrain} disabled={draining} className="btn btn-primary">
              {draining ? 'Processing…' : `Process queue (${queuedCount})`}
            </button>
          )}
        </div>

        {candidates.length === 0 && (
          <div className="text-center py-10 text-muted text-sm">
            {filter === 'ACTIVE'
              ? 'No candidates yet. Run a search above to populate.'
              : `No ${filter.toLowerCase()} candidates.`}
          </div>
        )}

        <div>
          {candidates.map(video => {
            const score = video.predictedScore ?? video.relevanceScore ?? 0;
            const hasPredicted = video.predictedScore !== null;
            const scoreColor = score >= 0.6 ? 'text-success' : score >= 0.3 ? 'text-warning' : 'text-subtle';
            const isImported = video.status === 'IMPORTED';
            const isSkipped = video.status === 'SKIPPED';
            const dim = isImported || isSkipped;
            const isSelected = selected.has(video.id);
            const canSelect = video.status === 'NEW';
            return (
              <div key={video.id} data-candidate
                className={`px-4 py-3 border-b-2 border-dashed border-line last:border-b-0 flex items-start gap-3 ${
                  isSelected ? 'bg-accent-tint' : ''
                } ${dim ? 'opacity-60' : ''}`}>
                {canSelect ? (
                  <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(video.id)}
                    className="mt-1 w-4 h-4 accent-accent" />
                ) : (
                  <div className="w-4" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-bold text-fg truncate">{video.title || video.youtubeId}</p>
                    <span className={`font-pixel text-[11px] px-1.5 rounded border-2 border-line ${
                      video.status === 'NEW' ? 'text-accent bg-accent-tint' :
                      video.status === 'QUEUED' ? 'text-warning bg-warning-tint' :
                      video.status === 'IMPORTED' ? 'text-success bg-success-tint' :
                      video.status === 'SKIPPED' ? 'text-subtle bg-surface-3' :
                      'text-error bg-error-tint'
                    }`}>{video.status}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted flex-wrap">
                    {video.channel && <span>{video.channel}</span>}
                    {video.duration > 0 && <span>{formatDurationSec(video.duration)}</span>}
                    {video.viewCount && video.viewCount > 0 && (
                      <span>{(video.viewCount / 1000).toFixed(1)}K views</span>
                    )}
                    {video.sourceMode && <span aria-hidden>&#8226;</span>}
                    {video.sourceMode && <span className="font-pixel text-subtle">{video.sourceMode}</span>}
                    {video.sourceMode === 'auto' && video.pickedBy && (
                      <span className={`font-pixel text-[11px] px-2 rounded-full border-2 border-line text-fg ${
                        video.pickedBy === 'algorithm' ? 'bg-surface-3' : 'bg-lilac'
                      }`} title={video.pickedBy === 'algorithm' ? 'Picked by the algorithm (no LLM)' : `Picked by the LLM agent (${video.pickedBy})`}>
                        {video.pickedBy === 'algorithm' ? 'algorithm' : `🤖 ${video.pickedBy}`}
                      </span>
                    )}
                  </div>
                  {video.why && video.why.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-fg">
                      {video.why.map(w => <li key={w} className="px-2 py-0.5 rounded-full bg-surface-2 border-2 border-line">{w}</li>)}
                    </ul>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-right">
                    <div className={`font-pixel text-xl leading-none ${scoreColor}`}>
                      {(score * 100).toFixed(0)}%
                    </div>
                    <div className="text-[10px] font-semibold text-muted">
                      {hasPredicted ? 'predicted' : video.transcriptScore === null ? 'enriching…' : 'relevance'}
                    </div>
                  </div>
                  <a href={video.url} target="_blank" rel="noreferrer"
                    className="btn px-2 py-1 bg-tang">YT</a>
                  {video.status === 'SKIPPED' ? (
                    <button onClick={() => handleUnskip(video.id)} className="btn px-2 py-1">Unskip</button>
                  ) : video.status === 'NEW' ? (
                    <button onClick={() => handleSkip(video.id)} className="btn px-2 py-1">Skip</button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Window>
    </div>
  );
}

export default function Home() {
  const api = useMemo(() => new ApiClient(), []);
  const [mainTab, setMainTab] = useState<MainTab>('import');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [videoGroups, setVideoGroups] = useState<VideoGroup[]>([]);
  const [clipScores, setClipScores] = useState<Record<string, ClipScore>>({});
  const [previewingClip, setPreviewingClip] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedClips, setSelectedClips] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [expandedVideos, setExpandedVideos] = useState<Set<string>>(new Set());
  const [activeTabs, setActiveTabs] = useState<Record<string, TabKey>>({});
  const [filterTiers, setFilterTiers] = useState<Record<string, string>>({});
  const [learningStats, setLearningStats] = useState<{ version: number; trained_on: number; total_feedback: number; with_actual_scores: number } | null>(null);
  const [training, setTraining] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollDelayRef = useRef<number>(POLL_MIN_MS);
  const pollLastStageRef = useRef<string | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);
  const [choices, setChoices] = useState<EditChoices>(FALLBACK_CHOICES);
  const [importSettings, setImportSettings] = useState<ImportSettings>({ options: {}, startTime: '', endTime: '' });
  const [editingClip, setEditingClip] = useState<Clip | null>(null);
  /** Clip id → version (updatedAt) after a re-render, to bust cached media. */
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<{ msg: string; ctx: string } | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
    pollDelayRef.current = POLL_MIN_MS;
    pollLastStageRef.current = null;
  }, []);

  const fetchClipsForVideo = useCallback(async (videoId: string) => {
    try {
      const data = await api.listClips(videoId) as { clips: Clip[] };
      const clipList: Clip[] = data.clips || [];
      const scores: Record<string, ClipScore> = {};
      for (const clip of clipList) {
        try {
          const detail = await api.getClip(clip.id) as ClipDetail;
          if (detail.scoreBreakdown) scores[clip.id] = detail.scoreBreakdown;
        } catch (e) { reportError(e, 'getClip'); }
      }
      setClipScores(prev => ({ ...prev, ...scores }));
      return clipList;
    } catch (e) { reportError(e, 'fetchClipsForVideo'); return []; }
  }, [api]);

  const loadAllData = useCallback(async () => {
    try {
      const [videosData, jobsData] = await Promise.all([
        api.listVideos() as Promise<{ videos: Video[] }>,
        api.listJobs() as Promise<{ jobs: Job[] }>,
      ]);
      const videos: Video[] = videosData.videos || [];
      const jobs: Job[] = jobsData.jobs || [];
      const jobMap = new Map(jobs.map(j => [j.videoId, j]));

      const runningJob = jobs.find(j => j.status === 'RUNNING' || j.status === 'QUEUED');

      const groups: VideoGroup[] = [];
      for (const video of videos) {
        const job = jobMap.get(video.id) || null;
        let clips: Clip[] = [];
        let jobDetail: JobDetail | null = null;

        if (job) {
          try {
            const jd = await api.getJob(job.id) as JobDetail;
            jobDetail = jd;
          } catch (e) { reportError(e, 'getJob'); }
        }

        if (job && (job.status === 'COMPLETED' || (runningJob && job.id === runningJob.id))) {
          clips = await fetchClipsForVideo(video.id);
        }

        groups.push({
          video,
          job,
          jobDetail,
          clips,
          expanded: false,
        });
      }

      groups.sort((a, b) => {
        if (runningJob) {
          if (a.job?.id === runningJob.id) return -1;
          if (b.job?.id === runningJob.id) return 1;
        }
        const aDate = a.job?.createdAt || a.video.createdAt;
        const bDate = b.job?.createdAt || b.video.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      });

      setVideoGroups(groups);

      if (runningJob) {
        setCurrentJobId(runningJob.id);
        setExpandedVideos(prev => new Set([...prev, runningJob.videoId]));
      } else if (groups.length > 0 && groups[0].clips.length > 0) {
        setExpandedVideos(prev => new Set([...prev, groups[0].video.id]));
      }

      try {
        const ws = await api.getWeightsStatus() as Record<string, unknown>;
        setLearningStats({
          version: ws.version as number,
          trained_on: ws.trained_on as number,
          total_feedback: ws.total_feedback as number,
          with_actual_scores: ws.with_actual_scores as number,
        });
      } catch (e) { reportError(e, 'getWeightsStatus'); }
    } catch (e) { reportError(e, 'loadAllData'); }
    setInitialLoad(false);
  }, [api, fetchClipsForVideo]);

  const pollJob = useCallback(async (jobId: string) => {
    // Abort any in-flight fetch from the previous tick so we don't pile up.
    if (pollAbortRef.current) pollAbortRef.current.abort();
    const ctrl = new AbortController();
    pollAbortRef.current = ctrl;

    let terminal = false;
    try {
      const data = await api.getJob(jobId) as JobDetail;

      // Stage transition → reset backoff so the UI catches up quickly.
      const stage = data.job.currentStage || data.job.status;
      if (pollLastStageRef.current !== null && pollLastStageRef.current !== stage) {
        pollDelayRef.current = POLL_MIN_MS;
      }
      pollLastStageRef.current = stage;

      setVideoGroups(prev => prev.map(g => {
        if (g.job?.id !== jobId) return g;
        return { ...g, jobDetail: data };
      }));

      if (data.job.status === 'COMPLETED') {
        terminal = true;
        stopPolling();
        setCurrentJobId(null);
        const clips = await fetchClipsForVideo(data.job.videoId);
        setVideoGroups(prev => prev.map(g => {
          if (g.video.id !== data.job.videoId) return g;
          return { ...g, clips, job: data.job, jobDetail: data };
        }));
        setExpandedVideos(prev => new Set([...prev, data.job.videoId]));
      } else if (data.job.status === 'FAILED' || data.job.status === 'CANCELLED') {
        terminal = true;
        stopPolling();
        setCurrentJobId(null);
        setVideoGroups(prev => prev.map(g => {
          if (g.job?.id !== jobId) return g;
          return { ...g, job: data.job, jobDetail: data };
        }));
      }
    } catch (e) {
      if (!isAbortError(e)) reportError(e, 'pollJob');
    } finally {
      if (!terminal && pollAbortRef.current === ctrl) {
        // Schedule the next poll with exponential backoff (capped).
        const next = Math.min(pollDelayRef.current * 2, POLL_MAX_MS);
        pollDelayRef.current = next;
        pollTimerRef.current = setTimeout(() => pollJob(jobId), next);
      }
    }
  }, [fetchClipsForVideo, stopPolling, api]);

  const startPolling = useCallback((jobId: string) => {
    stopPolling();
    pollDelayRef.current = POLL_MIN_MS;
    pollLastStageRef.current = null;
    pollJob(jobId);
  }, [pollJob, stopPolling]);

  useEffect(() => {
    loadAllData();
    return () => stopPolling();
  }, [loadAllData, stopPolling]);

  // A job found RUNNING/QUEUED on (re)load needs its poller started, otherwise
  // the UI sits on "Processing..." until a manual refresh. handleImport starts
  // its own poller synchronously, so the refs are already set in that case.
  useEffect(() => {
    if (currentJobId && !pollAbortRef.current && !pollTimerRef.current) startPolling(currentJobId);
  }, [currentJobId, startPolling]);

  useEffect(() => {
    Promise.all([api.getOptions(), api.listMusic()])
      .then(([opts, music]) => setChoices({ ...opts, music: music.tracks }))
      .catch((e) => reportError(e, 'loadOptions'));
  }, [api]);

  useEffect(() => {
    return onError((msg, ctx) => {
      setGlobalError({ msg, ctx });
    });
  }, []);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!youtubeUrl.trim()) return;
    setImporting(true);
    setImportError(null);
    try {
      const { startTime, endTime, options } = importSettings;
      const range = startTime.trim() || endTime.trim()
        ? { startTime: startTime.trim(), endTime: endTime.trim() }
        : undefined;
      const importData = await api.importVideo(youtubeUrl.trim(), undefined, range) as { videoId: string };
      const processData = await api.startProcessing(importData.videoId, options) as { jobId: string };
      setCurrentJobId(processData.jobId);
      startPolling(processData.jobId);
      setYoutubeUrl('');
      await loadAllData();
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const toggleExpanded = (videoId: string) => {
    setExpandedVideos(prev => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  };

  const getTab = (videoId: string): TabKey => activeTabs[videoId] || 'clips';
  const setTab = (videoId: string, tab: TabKey) => setActiveTabs(prev => ({ ...prev, [videoId]: tab }));
  const getFilter = (videoId: string): string => filterTiers[videoId] || 'ALL';
  const setFilter = (videoId: string, tier: string) => setFilterTiers(prev => ({ ...prev, [videoId]: tier }));

  const handleExportSelected = async (videoId: string) => {
    if (selectedClips.size === 0) return;
    setExporting(true);
    try {
      await api.exportClips(Array.from(selectedClips));
      setSelectedClips(new Set());
      const clips = await fetchClipsForVideo(videoId);
      setVideoGroups(prev => prev.map(g => g.video.id === videoId ? { ...g, clips } : g));
    } catch (e) { reportError(e, 'exportClips'); } finally {
      setExporting(false);
    }
  };

  const isActiveJob = currentJobId !== null;

  return (
    <div className="min-h-screen pb-32">
      <MenuBar tagline="Long videos → vertical clips with word-timed captions, for Indonesian short-form" />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-16">
      {globalError && (
        <div role="alert" className="mb-6 rounded-card border-3 border-line bg-error-tint shadow-hard px-4 py-3 text-sm text-fg flex items-start gap-3">
          <div className="flex-1">
            <span className="font-pixel text-xs">
              {globalError.ctx}
            </span>
            <p className="mt-0.5 font-semibold">{globalError.msg}</p>
          </div>
          <button
            onClick={() => setGlobalError(null)}
            className="btn px-2 py-0 text-base leading-6"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {mainTab === 'import' && (
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] items-start">
      <Window title="Import" bar="bg-aqua">
        <h2 className="heading text-[28px] mb-4">Long video in, <span className="highlight">clips out</span></h2>
        <form onSubmit={handleImport} className="space-y-3">
          <input
            type="text"
            value={youtubeUrl}
            onChange={e => setYoutubeUrl(e.target.value)}
            placeholder="Paste YouTube URL..."
            aria-label="YouTube URL"
            disabled={importing || isActiveJob}
            className="field w-full disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={importing || !youtubeUrl.trim() || isActiveJob}
            className="btn btn-primary w-full py-2.5 text-base heading"
          >
            {importing ? 'Importing...' : isActiveJob ? 'Processing...' : 'Import & Process'}
          </button>
        </form>
        {importError && <p className="text-error text-xs font-semibold mt-2">{importError}</p>}
        <ImportOptions value={importSettings} onChange={setImportSettings} choices={choices}
          disabled={importing || isActiveJob} />
      </Window>

      <Window title="Library" bar="bg-mint" right={initialLoad ? '…' : `${videoGroups.length} videos`} bodyClassName="p-4 sm:p-5">
      {initialLoad && (
        <div className="text-center py-12 text-subtle">
          <div className="animate-spin inline-block w-6 h-6 border-3 border-line border-t-sun rounded-full mb-2" />
          <p className="font-pixel">Loading...</p>
        </div>
      )}

      {!initialLoad && videoGroups.length === 0 && (
        <div className="text-center py-12 text-muted">
          <p>No videos yet. Import a YouTube URL above to get started.</p>
        </div>
      )}

      {!initialLoad && videoGroups.length > 0 && (
        <>
          <h2 className="heading text-[28px] mb-5">Videos ({videoGroups.length})</h2>
          <div className="space-y-5">
            {videoGroups.map(group => {
              const isExpanded = expandedVideos.has(group.video.id);
              const isRunning = currentJobId !== null && group.job?.id === currentJobId;
              const tab = getTab(group.video.id);
              const filterTier = getFilter(group.video.id);
              const filteredClips = filterTier === 'ALL' ? group.clips : group.clips.filter(c => c.tier === filterTier);
              const hasRendered = group.clips.some(c => c.renderStatus === 'COMPLETED');
              const tierCounts = {
                PRIMARY: group.clips.filter(c => c.tier === 'PRIMARY').length,
                BACKUP: group.clips.filter(c => c.tier === 'BACKUP').length,
                SKIP: group.clips.filter(c => c.tier === 'SKIP').length,
              };

              return (
                <div key={group.video.id} className={`rounded-card border-3 border-line shadow-hard-sm ${
                  isRunning ? 'bg-sun/40' : 'bg-surface-2'
                }`}>
                  <button
                    onClick={() => toggleExpanded(group.video.id)}
                    className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-3/60 rounded-t-[5px]"
                  >
                    <span aria-hidden className={`w-9 h-6 flex-none border-3 border-line rounded bg-tang relative before:absolute before:left-0.5 before:top-0.5 before:w-2.5 before:h-2.5 before:rounded-full before:bg-surface before:border-2 before:border-line after:absolute after:right-0.5 after:top-0.5 after:w-2.5 after:h-2.5 after:rounded-full after:bg-surface after:border-2 after:border-line ${
                      isExpanded ? 'bg-sun' : ''
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`w-2.5 h-2.5 flex-none rounded-full border-2 border-line ${STATUS_COLORS[group.job?.status || 'PENDING'] || 'bg-subtle'}`} />
                        <span className="text-sm font-semibold text-fg truncate">
                          {group.video.title || group.video.sourceUrl || group.video.id.substring(0, 8)}
                        </span>
                        <span className="text-xs text-subtle whitespace-nowrap">{timeAgo(group.video.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted flex-wrap">
                        <span className="font-pixel">{group.job?.status || 'No job'}</span>
                        {group.clips.length > 0 && (
                          <>
                            <span aria-hidden>&#8226;</span>
                            <span>{group.clips.length} clips</span>
                            {tierCounts.PRIMARY > 0 && <span className="text-success font-semibold">{tierCounts.PRIMARY} viral</span>}
                            {tierCounts.BACKUP > 0 && <span className="text-warning font-semibold">{tierCounts.BACKUP} potential</span>}
                          </>
                        )}
                        {isRunning && group.jobDetail && (
                          <>
                            <span aria-hidden>&#8226;</span>
                            <span className="text-accent font-semibold">
                              {Math.round(group.jobDetail.stages.filter(s => s.status === 'COMPLETED').length / STAGE_ORDER.length * 100)}% complete
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="font-pixel text-xs text-muted">{isExpanded ? 'Collapse' : 'Expand'}</span>
                    {group.job && (group.job.status === 'RUNNING' || group.job.status === 'QUEUED') && (
                      <button onClick={async (e) => {
                        e.stopPropagation();
                        try { await api.cancelJob(group.job!.id); await loadAllData(); } catch (e) { reportError(e, 'cancelJob'); }
                      }} className="btn ml-1 bg-warning-tint">
                        Cancel
                      </button>
                    )}
                    {(!group.job || group.job.status === 'FAILED' || group.job.status === 'CANCELLED' || group.job.status === 'COMPLETED') && (
                      <button onClick={async (e) => {
                        e.stopPropagation();
                        if (confirm('Delete this video and all its clips?')) {
                          try { await api.deleteVideo(group.video.id); await loadAllData(); } catch (e) { reportError(e, 'deleteVideo'); }
                        }
                      }} className="btn ml-1 bg-error-tint">
                        Delete
                      </button>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t-3 border-line">
                      {isRunning && group.jobDetail && (
                        <div className="px-4 py-4 bg-surface">
                          <ProgressBar stages={group.jobDetail.stages} />
                          {group.jobDetail.job.errorMessage && (
                            <p className="text-error text-xs mt-2">{group.jobDetail.job.errorMessage}</p>
                          )}
                        </div>
                      )}

                      {group.clips.length > 0 && (
                        <div className="px-4 py-4">
                          <div className="flex items-center gap-2 mb-5 flex-wrap">
                            <button
                              onClick={() => setTab(group.video.id, 'clips')}
                              className={`btn ${tab === 'clips' ? 'bg-accent text-white' : ''}`}
                            >Clips ({group.clips.length})</button>
                            <button
                              onClick={() => setTab(group.video.id, 'transcript')}
                              className={`btn ${tab === 'transcript' ? 'bg-accent text-white' : ''}`}
                            >Transcript</button>
                            <div className="ml-auto flex gap-1 flex-wrap">
                              {['ALL', 'PRIMARY', 'BACKUP', 'SKIP'].map(tier => (
                                <button key={tier} onClick={() => setFilter(group.video.id, tier)} className={`px-2.5 py-0.5 rounded-full border-2 border-line text-xs font-semibold ${
                                  filterTier === tier ? 'bg-fg text-sun' : 'bg-surface-2 text-fg hover:bg-surface-3'
                                }`}>{tier === 'ALL' ? 'All' : tierLabel(tier)}</button>
                              ))}
                            </div>
                          </div>

                          {selectedClips.size > 0 && hasRendered && (
                            <div className="flex items-center gap-3 mb-5 bg-sun border-3 border-line rounded-card p-3 shadow-hard-sm">
                              <span className="text-sm font-semibold">{selectedClips.size} selected</span>
                              <button onClick={() => handleExportSelected(group.video.id)} disabled={exporting} className="btn btn-primary">
                                {exporting ? 'Exporting...' : 'Export Selected'}
                              </button>
                              <button onClick={() => setSelectedClips(new Set())} className="btn">Clear</button>
                            </div>
                          )}

                          {tab === 'clips' && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2">
                              {filteredClips.map(clip => (
                                <ClipCard key={clip.id} clip={clip} score={clipScores[clip.id]} previewing={previewingClip === clip.id}
                                  selectable={!!clip.renderPath}
                                  selected={selectedClips.has(clip.id)}
                                  onSelect={() => {
                                    const next = new Set(selectedClips);
                                    if (next.has(clip.id)) next.delete(clip.id); else next.add(clip.id);
                                    setSelectedClips(next);
                                  }}
                                  onPreview={() => { setPreviewError(null); setPreviewingClip(previewingClip === clip.id ? null : clip.id); }}
                                  onExport={() => {
                                    api.exportClips([clip.id]).then(async () => {
                                      const clips = await fetchClipsForVideo(group.video.id);
                                      setVideoGroups(prev => prev.map(g => g.video.id === group.video.id ? { ...g, clips } : g));
                                    }).catch(() => {});
                                  }}
                                  onEdit={() => setEditingClip(clip)}
                                  api={api} />
                              ))}
                            </div>
                          )}

                          {tab === 'transcript' && (
                            <TranscriptView clips={group.clips} filterTier={filterTier} />
                          )}

                          {filteredClips.length === 0 && tab === 'clips' && (
                            <p className="text-muted text-sm py-8 text-center">No clips match this filter.</p>
                          )}
                        </div>
                      )}

                      {!isRunning && group.clips.length === 0 && group.job?.status === 'COMPLETED' && (
                        <div className="px-4 py-8 text-center text-muted text-sm">
                          Pipeline completed but no clips were generated. The video may be too short or no segments met the minimum duration.
                        </div>
                      )}

                      {!isRunning && !group.job && (
                        <div className="px-4 py-8 text-center text-muted text-sm">
                          Video imported but not processed yet.
                        </div>
                      )}

                      {!isRunning && group.job?.status === 'FAILED' && (
                        <div className="px-4 py-4">
                          <div className="bg-error-tint border-3 border-line rounded-card p-3">
                            <p className="text-fg text-sm font-bold mb-1">Pipeline Failed</p>
                            <p className="text-fg/80 text-xs">{group.job.errorMessage || 'Unknown error'}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      </Window>
      </div>
      )}

      {/* Discovery imports go Queue → Drain → backend import; no direct import here. */}
      {mainTab === 'discovery' && <DiscoveryPanel api={api} />}

      {mainTab === 'learning' && (
        <Window title="Learning" bar="bg-sun" className="max-w-3xl mx-auto">
            <h2 className="heading text-[28px] mb-4">Learning from your posts</h2>
            <p className="text-sm text-muted mb-5">
              Enter how your posted clips performed. After 5+ results, retraining re-weights the 13 scoring features by how well each one matched real performance.
            </p>
            {learningStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                {[
                  { value: learningStats.total_feedback, label: 'Total Feedback', fill: 'bg-surface-2' },
                  { value: learningStats.with_actual_scores, label: 'With Results', fill: 'bg-success-tint' },
                  { value: `v${learningStats.version}`, label: 'Weight Version', fill: 'bg-accent-tint' },
                  { value: learningStats.trained_on, label: 'Trained Samples', fill: 'bg-warning-tint' },
                ].map(s => (
                  <div key={s.label} className={`${s.fill} border-3 border-line rounded-card shadow-hard-sm p-4 text-center`}>
                    <div className="heading text-3xl">{s.value}</div>
                    <div className="font-pixel text-xs mt-1">{s.label}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-3 items-center flex-wrap">
              <button onClick={async () => {
                setTraining(true);
                try {
                  await api.trainWeights();
                  const ws = await api.getWeightsStatus() as Record<string, unknown>;
                  setLearningStats({
                    version: ws.version as number,
                    trained_on: ws.trained_on as number,
                    total_feedback: ws.total_feedback as number,
                    with_actual_scores: ws.with_actual_scores as number,
                  });
                } catch (e) { console.error(e); } finally {
                  setTraining(false);
                }
              }} disabled={training || !learningStats || learningStats.with_actual_scores < 5}
                className="btn btn-primary px-5 py-2 text-sm">
                {training ? 'Training...' : 'Retrain Weights'}
              </button>
              {learningStats && learningStats.with_actual_scores < 5 && (
                <span className="text-xs text-muted">
                  Need {5 - learningStats.with_actual_scores} more clips with feedback data to enable training
                </span>
              )}
            </div>
        </Window>
      )}
      </main>

      <Dock current={mainTab} onOpen={setMainTab} apps={[
        { key: 'import', label: 'Import & Clips', icon: ICONS.import },
        { key: 'discovery', label: 'Discover', icon: ICONS.discover },
        {
          key: 'learning',
          label: `Learning${
            learningStats && learningStats.with_actual_scores > 0
              ? ` (${learningStats.with_actual_scores})`
              : ''
          }`,
          icon: ICONS.learning,
        },
      ]} />

      {editingClip && (
        <ClipEditor clip={editingClip} api={api} choices={choices}
          onClose={() => setEditingClip(null)}
          onSaved={async (saved) => {
            setEditingClip(null);
            setVersions((v) => ({ ...v, [saved.id]: saved.updatedAt ?? String(Date.now()) }));
            const clips = await fetchClipsForVideo(saved.videoId);
            setVideoGroups((prev) => prev.map((g) => (g.video.id === saved.videoId ? { ...g, clips } : g)));
          }} />
      )}

      {previewingClip && (
        <div className="fixed inset-0 bg-bg/80 z-50 flex items-center justify-center p-4">
          <div className="win max-w-sm w-full overflow-hidden">
            <div className="win-bar bg-sun">
              <button onClick={() => { setPreviewingClip(null); setPreviewError(null); }} className="close grid place-items-center text-[9px] leading-none text-white">✕</button>
              <span className="stripes" aria-hidden />
              <h3 className="heading text-base px-1">Preview</h3>
              <span className="stripes" aria-hidden />
            </div>
            <div className="aspect-[9/16] bg-black flex items-center justify-center border-b-3 border-line">
              {previewError ? (
                <div className="text-center p-4">
                  <p className="text-error-tint text-sm font-semibold">{previewError}</p>
                  <p className="text-surface-3 text-xs mt-2">The clip may need to be re-rendered</p>
                </div>
              ) : (
                <video
                  src={api.getPreviewUrl(previewingClip, versions[previewingClip])}
                  controls
                  autoPlay
                  className="max-h-full max-w-full"
                  onError={() => setPreviewError('Unable to play this clip')}
                />
              )}
            </div>
            <p className="px-3 py-2 font-pixel text-sm flex items-center gap-2">
              Sorot: ON AIR <span aria-hidden className="pulse-dot w-2.5 h-2.5 rounded-full bg-hot border-2 border-line" />
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
