'use client';

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { ApiClient } from '@/lib/api';
import { reportError, onError, isAbortError } from '@/lib/errors';
import type {
  Video, Job, StageStatus, Clip, ClipScore,
  JobDetail, ClipDetail, VideoGroup, EditChoices,
} from '@/types';
import {
  STAGE_LABELS, TIER_COLORS, STAGE_ORDER, STATUS_COLORS,
  formatTime, formatDuration, formatDurationSec, timeAgo, tierLabel, videoLabel,
} from '@/lib/ui-utils';
import { ProgressBar, ScoreBadge, TranscriptView } from '@/components/progress';
import { FALLBACK_CHOICES, ImportOptions, type ImportSettings } from '@/components/ImportOptions';
import { ClipEditor } from '@/components/ClipEditor';

// Adaptive polling bounds for job status — start fast so stage transitions
// feel snappy, back off so a 6-min RENDER stage doesn't fire 180 requests.
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 10000;

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
      setFeedbackError('Isi tanggal upload TikTok dulu — viral score butuh durasi di platform.');
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
    <div className={`bg-surface-2 rounded-lg overflow-hidden border transition-colors ${
      selected ? 'border-accent ring-1 ring-accent/30' : 'border-line hover:border-line'
    }`}>
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            {selectable && (
              <button
                onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
                className={`w-5 h-5 rounded flex items-center justify-center border transition-colors flex-shrink-0 ${
                  selected
                    ? 'bg-accent border-accent text-white'
                    : 'bg-surface border-line hover:border-fg/20'
                }`}
                aria-label="Select clip"
              >
                {selected && (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )}
            <span className="text-lg font-bold text-fg">#{clip.rankPos || '-'}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium border ${TIER_COLORS[clip.tier] || ''}`}>
              {tierLabel(clip.tier)}
            </span>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-fg">{clip.score ? (clip.score * 100).toFixed(0) : '-'}</div>
            <div className="text-xs text-subtle">score</div>
          </div>
        </div>
        {clip.title && (
          <p className="text-sm font-medium text-fg mb-1 line-clamp-2">{clip.title}</p>
        )}
        <div className="flex gap-4 text-xs text-muted mb-3">
          <span>{formatTime(clip.startTime)} &#8594; {formatTime(clip.endTime)}</span>
          <span>&#8226;</span>
          <span>{formatDuration(clip.durationSec)}</span>
        </div>
        {clip.textContent && (
          <p className="text-sm text-fg/85 line-clamp-3 mb-3">{clip.textContent}</p>
        )}
        <div className="flex gap-2">
          {clip.renderPath && (
            <button onClick={onPreview} className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
              previewing ? 'bg-accent text-white' : 'bg-surface-3 text-fg/85 hover:bg-surface-3'
            }`}>{previewing ? 'Playing...' : 'Preview'}</button>
          )}
          {score && (
            <button onClick={() => setShowScore(!showScore)} className="flex-1 py-1.5 rounded text-xs font-medium bg-surface-3 text-fg/85 hover:bg-surface-3 transition-colors">
              {showScore ? 'Hide' : 'Score'}
            </button>
          )}
          {(clip.title || clip.description) && (
            <button onClick={() => setShowMeta(!showMeta)} className="flex-1 py-1.5 rounded text-xs font-medium bg-accent text-fg hover:bg-accent/90 transition-colors">
              {showMeta ? 'Hide' : 'Copy'}
            </button>
          )}
          {clip.exportPath && (
            <a href={api.getExportUrl(clip.id, clip.updatedAt)} className="flex-1 py-1.5 rounded text-xs font-medium bg-success text-white hover:bg-success/90 transition-colors text-center">Download</a>
          )}
          {!clip.exportPath && clip.renderStatus === 'COMPLETED' && (
            <button onClick={onExport} className="flex-1 py-1.5 rounded text-xs font-medium bg-surface-3 text-fg/85 hover:bg-surface-3 transition-colors">Export</button>
          )}
          <button onClick={onEdit} className="py-1.5 px-2 rounded text-xs font-medium bg-surface-3 text-fg/85 hover:bg-surface-3 transition-colors">
            Edit
          </button>
          <button onClick={() => setShowFeedback(!showFeedback)} className="py-1.5 px-2 rounded text-xs font-medium bg-surface-3 text-muted hover:bg-surface-3 transition-colors">
            {viralScore !== null ? `${(viralScore * 100).toFixed(0)}%` : 'FB'}
          </button>
        </div>
      </div>
      {showMeta && (clip.title || clip.description) && (
        <div className="border-t border-line px-4 py-3 space-y-2">
          {clip.title && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-subtle font-medium">Title</span>
                <button onClick={() => handleCopy(clip.title!, 'title')} className="text-xs text-accent hover:text-accent/80">
                  {copied === 'title' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-sm text-fg bg-bg rounded p-2">{clip.title}</p>
            </div>
          )}
          {clip.description && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-subtle font-medium">Description</span>
                <button onClick={() => handleCopy(clip.description!, 'desc')} className="text-xs text-accent hover:text-accent/80">
                  {copied === 'desc' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-sm text-fg/85 bg-bg rounded p-2 whitespace-pre-wrap">{clip.description}</p>
            </div>
          )}
        </div>
      )}
      {showFeedback && (
        <div className="border-t border-line px-4 py-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted font-medium block">
              Tanggal & jam upload ke TikTok
              <span className="text-accent ml-1">*</span>
            </label>
            <input
              type="datetime-local"
              value={feedback.postedAt}
              onChange={e => setFeedback(f => ({ ...f, postedAt: e.target.value }))}
              max={new Date(Date.now() - 60000).toISOString().slice(0, 16)}
              className="bg-surface border border-line rounded px-2 py-1.5 text-xs text-fg w-full"
            />
            <p className="text-xs text-subtle">
              Viral score dihitung per-hari (velocity), jadi durasi di TikTok wajib diisi.
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted font-medium block">Metrik TikTok saat ini</span>
            <div className="grid grid-cols-5 gap-1">
              <input type="number" placeholder="Views" value={feedback.views} onChange={e => setFeedback(f => ({...f, views: e.target.value}))}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg w-full" />
              <input type="number" placeholder="Likes" value={feedback.likes} onChange={e => setFeedback(f => ({...f, likes: e.target.value}))}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg w-full" />
              <input type="number" placeholder="Comments" value={feedback.comments} onChange={e => setFeedback(f => ({...f, comments: e.target.value}))}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg w-full" />
              <input type="number" placeholder="Shares" value={feedback.shares} onChange={e => setFeedback(f => ({...f, shares: e.target.value}))}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg w-full" />
              <input type="number" placeholder="Saves" value={feedback.saves} onChange={e => setFeedback(f => ({...f, saves: e.target.value}))}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-fg w-full" />
            </div>
          </div>
          {feedbackError && (
            <p className="text-xs text-error bg-error-tint border border-error/30 rounded px-2 py-1">
              {feedbackError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button onClick={handleSubmitFeedback} disabled={submitting}
              className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:bg-surface-3 disabled:text-subtle transition-colors">
              {submitting ? 'Saving...' : 'Submit feedback'}
            </button>
            {viralScore !== null && (
              <span className="text-xs font-mono text-success">
                Viral Score: {(viralScore * 100).toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      )}
      {showScore && score && (
        <div className="border-t border-line px-4 py-3 space-y-1">
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
          <div className="border-t border-line pt-1 mt-1">
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
    <div className="space-y-4">
      <div className="bg-surface rounded-card p-6 border border-line">
        <div className="flex gap-2 mb-4">
          {(['auto', 'search', 'trending', 'channel'] as DiscoveryMode[]).map(m => (
            <button key={m} onClick={() => setMode(m)} className={`px-4 py-2 rounded-card text-sm font-medium transition-colors border ${
              mode === m ? 'bg-accent text-white border-accent' : 'bg-surface-2 text-muted border-line hover:bg-surface-3'
            }`}>{m === 'auto' ? '✨ Auto' : m.charAt(0).toUpperCase() + m.slice(1)}</button>
          ))}
        </div>

        <div className="flex gap-3">
          {mode === 'auto' && (
            <input type="text" value={goal} onChange={e => setGoal(e.target.value)}
              placeholder="Optional focus (e.g. drama artis, politik, podcast bisnis)…"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="flex-1 bg-surface-2 border border-line rounded-card px-3 py-2 text-sm focus:outline-none focus:border-accent" />
          )}
          {mode === 'search' && (
            <input type="text" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search keywords (e.g. rahasia penting indonesia)…"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="flex-1 bg-surface-2 border border-line rounded-card px-3 py-2 text-sm focus:outline-none focus:border-accent" />
          )}
          {mode === 'channel' && (
            <input type="text" value={channelUrl} onChange={e => setChannelUrl(e.target.value)}
              placeholder="YouTube channel URL (e.g. https://youtube.com/@channel)"
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="flex-1 bg-surface-2 border border-line rounded-card px-3 py-2 text-sm focus:outline-none focus:border-accent" />
          )}
          {mode === 'trending' && (
            <div className="flex-1 text-sm text-muted py-2">Fetches current Indonesian trending videos</div>
          )}
          <button onClick={handleSearch} disabled={loading || (mode === 'auto' && autoRun?.status === 'RUNNING')}
            className="px-6 bg-accent hover:bg-accent-soft disabled:bg-surface-3 disabled:text-subtle text-white rounded-card py-2 text-sm font-medium transition-colors whitespace-nowrap">
            {loading ? 'Searching…' : mode !== 'auto' ? 'Discover' : autoRun?.status === 'RUNNING' ? 'Researching…' : 'Auto-discover'}
          </button>
        </div>
        {error && <p className="text-error text-xs mt-2">{error}</p>}
        {mode === 'auto' && autoRun && (
          <div className="mt-3 text-xs space-y-1" data-testid="auto-run">
            {autoRun.status === 'DONE' && (
              <p className="text-fg">
                {autoRun.mode === 'agent' ? `Picked ${autoRun.count} by ${autoRun.model}` : `Picked ${autoRun.count} by the algorithm`}
                {autoRun.mode === 'algorithm' && autoRun.llmError && <span className="text-subtle"> — {autoRun.llmError}</span>}
              </p>
            )}
            {autoRun.notes && <p className="text-muted">Trend: {autoRun.notes}</p>}
            <ul className="font-mono text-subtle space-y-0.5">
              {autoRun.steps.slice(-8).map((s, i) => (
                <li key={i}>{s.tool} {String(s.args.query ?? s.args.video_id ?? s.args.channel ?? '')} → {s.result}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-subtle mt-3">
          {mode === 'auto'
            ? 'Auto researches what is trending (web + YouTube), reads the whole captions of promising videos and picks the ones worth clipping, with a reason for each. It uses the LLM when one is configured, otherwise the algorithm.'
            : <>Results persist across refreshes. Top candidates are scored from their whole captions in the background —
              check back in a few seconds for a <span className="font-mono text-accent">predicted</span> score that reflects the
              actual video content, not just the title.</>}
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 p-1 bg-surface rounded-card border border-line">
          {(['ACTIVE', 'NEW', 'QUEUED', 'IMPORTED', 'SKIPPED'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                filter === f ? 'bg-accent text-white' : 'text-muted hover:text-fg'
              }`}>
              {f === 'ACTIVE' ? `All (${newCount + queuedCount})` : f}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {selected.size > 0 && (
          <button onClick={handleQueueSelected}
            className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-card hover:bg-accent-soft transition-colors">
            Queue {selected.size} selected
          </button>
        )}
        {queuedCount > 0 && (
          <button onClick={handleDrain} disabled={draining}
            className="px-3 py-1.5 text-xs font-medium bg-success text-white rounded-card hover:opacity-90 disabled:bg-surface-3 transition-colors">
            {draining ? 'Processing…' : `Process queue (${queuedCount})`}
          </button>
        )}
      </div>

      {candidates.length === 0 && (
        <div className="text-center py-8 text-subtle text-sm border border-line rounded-card bg-surface">
          {filter === 'ACTIVE'
            ? 'No candidates yet. Run a search above to populate.'
            : `No ${filter.toLowerCase()} candidates.`}
        </div>
      )}

      <div className="space-y-2">
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
            <div key={video.id}
              className={`rounded-card p-4 border flex items-start gap-3 transition-colors ${
                isSelected ? 'bg-accent-tint border-accent' : 'bg-surface border-line'
              } ${dim ? 'opacity-60' : ''}`}>
              {canSelect ? (
                <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(video.id)}
                  className="mt-1 accent-accent" />
              ) : (
                <div className="w-4" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-medium text-fg truncate">{video.title || video.youtubeId}</p>
                  <span className={`text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                    video.status === 'NEW' ? 'text-accent bg-accent-tint border-accent/30' :
                    video.status === 'QUEUED' ? 'text-warning bg-warning-tint border-warning/30' :
                    video.status === 'IMPORTED' ? 'text-success bg-success-tint border-success/30' :
                    video.status === 'SKIPPED' ? 'text-subtle bg-surface-2 border-line' :
                    'text-error bg-error-tint border-error/30'
                  }`}>{video.status}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted flex-wrap">
                  {video.channel && <span>{video.channel}</span>}
                  {video.duration > 0 && <span>{formatDurationSec(video.duration)}</span>}
                  {video.viewCount && video.viewCount > 0 && (
                    <span>{(video.viewCount / 1000).toFixed(1)}K views</span>
                  )}
                  {video.sourceMode && <span aria-hidden>&#8226;</span>}
                  {video.sourceMode && <span className="font-mono text-subtle">{video.sourceMode}</span>}
                </div>
                {video.why && video.why.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted">
                    {video.why.map(w => <li key={w} className="px-1.5 py-0.5 rounded bg-surface-2 border border-line">{w}</li>)}
                  </ul>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="text-right">
                  <div className={`text-sm font-mono font-semibold ${scoreColor}`}>
                    {(score * 100).toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-subtle">
                    {hasPredicted ? 'predicted' : video.transcriptScore === null ? 'enriching…' : 'relevance'}
                  </div>
                </div>
                <a href={video.url} target="_blank" rel="noreferrer"
                  className="text-xs text-subtle hover:text-accent underline">YT</a>
                {video.status === 'SKIPPED' ? (
                  <button onClick={() => handleUnskip(video.id)}
                    className="px-2 py-1 text-xs text-muted hover:text-fg">Unskip</button>
                ) : video.status === 'NEW' ? (
                  <button onClick={() => handleSkip(video.id)}
                    className="px-2 py-1 text-xs text-subtle hover:text-error transition-colors">Skip</button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
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
    <main className="max-w-5xl mx-auto px-6 py-12">
      <header className="mb-10 border-b border-line pb-6">
        <h1 className="text-3xl font-bold tracking-tight text-fg mb-1">
          Viral Clipper
        </h1>
        <p className="text-muted text-sm">
          AI-powered video clip maker for Indonesian TikTok content
        </p>
      </header>

      {globalError && (
        <div className="mb-6 rounded-card border border-error/30 bg-error-tint px-4 py-3 text-sm text-error flex items-start gap-3">
          <div className="flex-1">
            <span className="font-mono text-xs uppercase tracking-wider opacity-70">
              {globalError.ctx}
            </span>
            <p className="mt-0.5">{globalError.msg}</p>
          </div>
          <button
            onClick={() => setGlobalError(null)}
            className="text-error hover:text-error/70 leading-none text-xl"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <nav className="flex gap-1 mb-8 border-b border-line">
        {([
          { key: 'import' as const, label: 'Import & Clips' },
          { key: 'discovery' as const, label: 'Discover' },
          {
            key: 'learning' as const,
            label: `Learning${
              learningStats && learningStats.with_actual_scores > 0
                ? ` (${learningStats.with_actual_scores})`
                : ''
            }`,
          },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setMainTab(tab.key)}
            className={`px-5 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
              mainTab === tab.key
                ? 'text-fg border-accent'
                : 'text-muted border-transparent hover:text-fg'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {mainTab === 'import' && (
      <section className="bg-surface rounded-lg p-6 mb-8">
        <h2 className="text-2xl font-semibold mb-5 text-fg">Import Video</h2>
        <form onSubmit={handleImport} className="flex gap-3">
          <input
            type="text"
            value={youtubeUrl}
            onChange={e => setYoutubeUrl(e.target.value)}
            placeholder="Paste YouTube URL..."
            disabled={importing || isActiveJob}
            className="flex-1 bg-surface-2 border border-line rounded px-3 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={importing || !youtubeUrl.trim() || isActiveJob}
            className="px-6 bg-accent hover:bg-accent/90 disabled:bg-surface-3 disabled:text-subtle text-white rounded py-2 text-sm font-medium transition-colors whitespace-nowrap"
          >
            {importing ? 'Importing...' : isActiveJob ? 'Processing...' : 'Import & Process'}
          </button>
        </form>
        {importError && <p className="text-error text-xs mt-2">{importError}</p>}
        <ImportOptions value={importSettings} onChange={setImportSettings} choices={choices}
          disabled={importing || isActiveJob} />
       </section>
      )}

      {mainTab === 'import' && initialLoad && (
        <div className="text-center py-12 text-subtle">
          <div className="animate-spin inline-block w-6 h-6 border-2 border-accent border-t-transparent rounded-full mb-2" />
          <p>Loading...</p>
        </div>
      )}

      {mainTab === 'import' && !initialLoad && videoGroups.length === 0 && (
        <div className="text-center py-12 text-subtle">
          <p>No videos yet. Import a YouTube URL above to get started.</p>
        </div>
      )}

      {mainTab === 'import' && !initialLoad && videoGroups.length > 0 && (
        <section>
          <h2 className="text-2xl font-semibold mb-5 text-fg">Videos ({videoGroups.length})</h2>
          <div className="space-y-4">
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
                <div key={group.video.id} className={`bg-surface rounded-lg border transition-colors ${
                  isRunning ? 'border-accent/50' : 'border-line'
                }`}>
                  <button
                    onClick={() => toggleExpanded(group.video.id)}
                    className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-surface-2 transition-colors"
                  >
                    <span className={`text-lg transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[group.job?.status || 'PENDING'] || 'bg-subtle'}`} />
                        <span className="text-sm font-medium text-fg truncate">
                          {group.video.title || group.video.sourceUrl || group.video.id.substring(0, 8)}
                        </span>
                        <span className="text-xs text-subtle">{timeAgo(group.video.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-subtle">
                        <span>{group.job?.status || 'No job'}</span>
                        {group.clips.length > 0 && (
                          <>
                            <span aria-hidden>&#8226;</span>
                            <span>{group.clips.length} clips</span>
                            {tierCounts.PRIMARY > 0 && <span className="text-success">{tierCounts.PRIMARY} viral</span>}
                            {tierCounts.BACKUP > 0 && <span className="text-warning">{tierCounts.BACKUP} potential</span>}
                          </>
                        )}
                        {isRunning && group.jobDetail && (
                          <>
                            <span aria-hidden>&#8226;</span>
                            <span className="text-accent">
                              {Math.round(group.jobDetail.stages.filter(s => s.status === 'COMPLETED').length / STAGE_ORDER.length * 100)}% complete
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-subtle">{isExpanded ? 'Collapse' : 'Expand'}</span>
                    {group.job && (group.job.status === 'RUNNING' || group.job.status === 'QUEUED') && (
                      <button onClick={async (e) => {
                        e.stopPropagation();
                        try { await api.cancelJob(group.job!.id); await loadAllData(); } catch (e) { reportError(e, 'cancelJob'); }
                      }} className="ml-2 px-3 py-1 rounded text-xs font-medium bg-warning text-white hover:bg-warning/90 transition-colors">
                        Cancel
                      </button>
                    )}
                    {(!group.job || group.job.status === 'FAILED' || group.job.status === 'CANCELLED' || group.job.status === 'COMPLETED') && (
                      <button onClick={async (e) => {
                        e.stopPropagation();
                        if (confirm('Delete this video and all its clips?')) {
                          try { await api.deleteVideo(group.video.id); await loadAllData(); } catch (e) { reportError(e, 'deleteVideo'); }
                        }
                      }} className="ml-2 px-3 py-1 rounded text-xs font-medium bg-error text-white hover:bg-error/90 transition-colors">
                        Delete
                      </button>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-line">
                      {isRunning && group.jobDetail && (
                        <div className="px-5 py-4 bg-surface-2/30">
                          <ProgressBar stages={group.jobDetail.stages} />
                          {group.jobDetail.job.errorMessage && (
                            <p className="text-error text-xs mt-2">{group.jobDetail.job.errorMessage}</p>
                          )}
                        </div>
                      )}

                      {group.clips.length > 0 && (
                        <div className="px-5 py-4">
                          <div className="flex items-center gap-2 mb-4 border-b border-line">
                            <button
                              onClick={() => setTab(group.video.id, 'clips')}
                              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                tab === 'clips' ? 'border-accent text-accent' : 'border-transparent text-subtle hover:text-fg/85'
                              }`}
                            >Clips ({group.clips.length})</button>
                            <button
                              onClick={() => setTab(group.video.id, 'transcript')}
                              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                tab === 'transcript' ? 'border-accent text-accent' : 'border-transparent text-subtle hover:text-fg/85'
                              }`}
                            >Transcript</button>
                            <div className="ml-auto flex gap-1">
                              {['ALL', 'PRIMARY', 'BACKUP', 'SKIP'].map(tier => (
                                <button key={tier} onClick={() => setFilter(group.video.id, tier)} className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                                  filterTier === tier ? 'bg-accent text-white' : 'bg-surface-2 text-muted hover:bg-surface-3'
                                }`}>{tier === 'ALL' ? 'All' : tierLabel(tier)}</button>
                              ))}
                            </div>
                          </div>

                          {selectedClips.size > 0 && hasRendered && (
                            <div className="flex items-center gap-3 mb-4 bg-surface-2 rounded-lg p-3">
                              <span className="text-sm text-muted">{selectedClips.size} selected</span>
                              <button onClick={() => handleExportSelected(group.video.id)} disabled={exporting} className="px-4 py-1.5 rounded text-xs font-medium bg-success text-white hover:bg-success/90 disabled:bg-surface-3 transition-colors">
                                {exporting ? 'Exporting...' : 'Export Selected'}
                              </button>
                              <button onClick={() => setSelectedClips(new Set())} className="px-3 py-1.5 rounded text-xs font-medium bg-surface-2 text-muted hover:bg-surface-3 transition-colors">Clear</button>
                            </div>
                          )}

                          {tab === 'clips' && (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                            <p className="text-subtle text-sm py-8 text-center">No clips match this filter.</p>
                          )}
                        </div>
                      )}

                      {!isRunning && group.clips.length === 0 && group.job?.status === 'COMPLETED' && (
                        <div className="px-5 py-8 text-center text-subtle text-sm">
                          Pipeline completed but no clips were generated. The video may be too short or no segments met the minimum duration.
                        </div>
                      )}

                      {!isRunning && !group.job && (
                        <div className="px-5 py-8 text-center text-subtle text-sm">
                          Video imported but not processed yet.
                        </div>
                      )}

                      {!isRunning && group.job?.status === 'FAILED' && (
                        <div className="px-5 py-4">
                          <div className="bg-error-tint border border-error/30 rounded p-3">
                            <p className="text-error text-sm font-medium mb-1">Pipeline Failed</p>
                            <p className="text-error/70 text-xs">{group.job.errorMessage || 'Unknown error'}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
           </section>
      )}

      {/* Discovery imports go Queue → Drain → backend import; no direct import here. */}
      {mainTab === 'discovery' && <DiscoveryPanel api={api} />}

      {mainTab === 'learning' && (
        <section className="space-y-4">
          <div className="bg-surface rounded-lg p-6">
            <h2 className="text-2xl font-semibold mb-5 text-fg">Self-Learning Scoring</h2>
            <p className="text-sm text-muted mb-4">
              Submit TikTok performance data for your clips to train the scoring weights. After enough feedback, the system will automatically adjust which features matter most.
            </p>
            {learningStats && (
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="bg-surface-2 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-fg">{learningStats.total_feedback}</div>
                  <div className="text-xs text-subtle">Total Feedback</div>
                </div>
                <div className="bg-surface-2 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-success">{learningStats.with_actual_scores}</div>
                  <div className="text-xs text-subtle">With TikTok Data</div>
                </div>
                <div className="bg-surface-2 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-accent">v{learningStats.version}</div>
                  <div className="text-xs text-subtle">Weight Version</div>
                </div>
                <div className="bg-surface-2 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-warning">{learningStats.trained_on}</div>
                  <div className="text-xs text-subtle">Trained Samples</div>
                </div>
              </div>
            )}
            <div className="flex gap-3">
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
                className="px-6 py-2.5 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 disabled:bg-surface-3 disabled:text-subtle transition-colors">
                {training ? 'Training...' : 'Retrain Weights'}
              </button>
              {learningStats && learningStats.with_actual_scores < 5 && (
                <span className="text-xs text-subtle py-2">
                  Need {5 - learningStats.with_actual_scores} more clips with feedback data to enable training
                </span>
              )}
            </div>
          </div>
        </section>
      )}

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
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-surface rounded-lg max-w-sm w-full overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-line">
              <h3 className="text-lg font-semibold text-fg">Preview</h3>
              <button onClick={() => { setPreviewingClip(null); setPreviewError(null); }} className="text-muted hover:text-fg">&#10005;</button>
            </div>
            <div className="aspect-[9/16] bg-black flex items-center justify-center">
              {previewError ? (
                <div className="text-center p-4">
                  <p className="text-error text-sm">{previewError}</p>
                  <p className="text-subtle text-xs mt-2">The clip may need to be re-rendered</p>
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
          </div>
        </div>
      )}
    </main>
  );
}
