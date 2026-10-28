// Small display components: pipeline ProgressBar, ScoreBadge, TranscriptView.
// Retro desktop styling: hazard-striped bar, a numbered 9-step strip.

import type { Clip, StageStatus } from '@/types';
import {
  STAGE_ORDER,
  STAGE_LABELS,
  TIER_COLORS,
  formatTime,
  formatDuration,
  tierLabel,
} from '@/lib/ui-utils';

const LIVE_STAGES = ['TRANSCRIBE', 'SEGMENT', 'SCORE', 'RENDER', 'SUBTITLE'];

export function ProgressBar({ stages }: { stages: StageStatus[] }) {
  const total = STAGE_ORDER.length;
  const completed = stages.filter(s => s.status === 'COMPLETED').length;
  const current = stages.find(s => s.status === 'RUNNING' || s.status === 'IN_PROGRESS');
  const pct = Math.round((completed / total) * 100);
  // Stages that report as they go: "Transcribing 37%", "LLM picking moments 3/14",
  // "Jev checking clips", "Rendering 3/8 clips".
  const live = current && LIVE_STAGES.includes(current.stage) ? current.outputPath : null;

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline text-sm">
        <span className="font-semibold">
          {current ? STAGE_LABELS[current.stage] || current.stage : 'Waiting…'}
        </span>
        <span className="font-pixel text-sm">{pct}%</span>
      </div>
      <div className="h-6 bg-surface-2 border-3 border-line rounded-md overflow-hidden">
        <div
          className="progress-stripes h-full border-r-3 border-line transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {live && (
        <p className="font-pixel text-sm bg-[#1D2B1D] text-[#9CFF9C] border-3 border-line rounded-md px-3 py-1">{live}</p>
      )}
      <div className="grid grid-cols-9 border-3 border-line rounded-md overflow-hidden">
        {STAGE_ORDER.map((stage, i) => {
          const stageStatus = stages.find(s => s.stage === stage);
          const status = stageStatus?.status || 'PENDING';
          const isCurrent = status === 'RUNNING' || status === 'IN_PROGRESS';
          const isDone = status === 'COMPLETED';
          const isFailed = status === 'FAILED';
          return (
            <div
              key={stage}
              className={`flex flex-col items-center py-1 font-pixel text-xs leading-tight ${i > 0 ? 'border-l-3 border-line' : ''} ${
                isDone ? 'bg-mint' :
                isCurrent ? 'bg-sun stage-blink' :
                isFailed ? 'bg-error-tint' :
                'bg-surface-2 text-subtle'
              }`}
              title={STAGE_LABELS[stage] || stage}
              aria-label={`${STAGE_LABELS[stage] || stage}: ${status.toLowerCase()}`}
            >
              <span className="heading text-base text-fg">{i + 1}</span>
              <span aria-hidden>{isDone ? '✓' : isFailed ? '✗' : isCurrent ? '●' : '○'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ScoreBadge({ score, label }: { score: number | null; label: string }) {
  if (score === null) return null;
  const color =
    score >= 0.7 ? 'text-success' :
    score >= 0.4 ? 'text-warning' : 'text-error';
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-muted">{label}</span>
      <span className={`font-mono ${color}`}>{(score * 100).toFixed(0)}%</span>
    </div>
  );
}

export function TranscriptView({ clips, filterTier }: { clips: Clip[]; filterTier: string }) {
  const filtered = filterTier === 'ALL' ? clips : clips.filter(c => c.tier === filterTier);
  if (filtered.length === 0) {
    return <p className="text-subtle text-sm py-4">No clips to show.</p>;
  }

  return (
    <div className="space-y-3">
      {filtered.map(clip => (
        <div
          key={clip.id}
          className="bg-surface-2 rounded-card p-4 border-3 border-line"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="font-pixel text-sm text-fg">
              #{clip.rankPos || '-'}
            </span>
            <span
              className={`px-2 py-0.5 rounded text-xs font-bold border-2 border-line ${TIER_COLORS[clip.tier] || ''}`}
            >
              {tierLabel(clip.tier)}
            </span>
            <span className="text-xs font-mono text-subtle">
              {formatTime(clip.startTime)} → {formatTime(clip.endTime)} ({formatDuration(clip.durationSec)})
            </span>
            {clip.score !== null && (
              <span className="ml-auto heading text-lg">
                {(clip.score * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {clip.textContent ? (
            <p className="text-sm text-fg/85 leading-relaxed whitespace-pre-wrap">
              {clip.textContent}
            </p>
          ) : (
            <p className="text-sm text-subtle italic">No transcript available</p>
          )}
        </div>
      ))}
    </div>
  );
}
