// UI formatting helpers + static display maps. Extracted from page.tsx during
// the P3.3 split.

import type { Video } from '@/types';

export const STAGE_LABELS: Record<string, string> = {
  IMPORT: 'Import Video',
  AUDIO_EXTRACT: 'Extract Audio',
  TRANSCRIBE: 'Transcribe',
  SEGMENT: 'Segment',
  SCORE: 'Score',
  RENDER: 'Render Clips',
  SUBTITLE: 'Add Subtitles',
  VARIATION: 'Generate Variations',
  ANALYTICS: 'Analytics',
};

export const TIER_COLORS: Record<string, string> = {
  PRIMARY: 'bg-success-tint text-fg',
  BACKUP: 'bg-warning-tint text-fg',
  SKIP: 'bg-surface-3 text-fg',
};

export const STAGE_ORDER = [
  'IMPORT', 'AUDIO_EXTRACT', 'TRANSCRIBE', 'SEGMENT',
  'SCORE', 'RENDER', 'SUBTITLE', 'VARIATION', 'ANALYTICS',
];

export const STATUS_COLORS: Record<string, string> = {
  COMPLETED: 'bg-success',
  FAILED: 'bg-error',
  RUNNING: 'bg-accent animate-pulse',
  PENDING: 'bg-subtle',
  IN_PROGRESS: 'bg-accent animate-pulse',
  QUEUED: 'bg-warning',
  CANCELLED: 'bg-subtle',
};

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatDuration(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

export function formatDurationSec(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function timeAgo(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch { return ''; }
}

export function tierLabel(tier: string): string {
  switch (tier) {
    case 'PRIMARY': return 'VIRAL';
    case 'BACKUP': return 'POTENTIAL';
    case 'SKIP': return 'SKIP';
    default: return tier;
  }
}

export function videoLabel(video: Video): string {
  if (video.sourceUrl && video.sourceUrl.startsWith('http')) {
    try {
      const url = new URL(video.sourceUrl);
      return url.hostname + url.pathname.substring(0, 30);
    } catch { return video.sourceUrl.substring(0, 40); }
  }
  return video.sourceUrl || video.id.substring(0, 8);
}
