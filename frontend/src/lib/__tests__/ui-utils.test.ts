import {
  formatTime, formatDuration, formatDurationSec, timeAgo, tierLabel, videoLabel,
  STAGE_ORDER, STAGE_LABELS,
} from '../ui-utils';
import type { Video } from '@/types';

const video = (sourceUrl: string | null, id = 'abcdef123456'): Video =>
  ({ id, sourceType: 'YOUTUBE', sourceUrl, title: null, filePath: null, createdAt: '' });

describe('formatters', () => {
  it('formats m:ss and seconds', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(125.9)).toBe('2:05');
    expect(formatDuration(27.64)).toBe('27.6s');
    expect(formatDurationSec(3605)).toBe('60:05');
  });

  it('every pipeline stage has a label', () => {
    for (const s of STAGE_ORDER) expect(STAGE_LABELS[s]).toBeTruthy();
  });
});

describe('timeAgo', () => {
  const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
  it.each([
    [10, 'just now'],
    [5 * 60, '5m ago'],
    [3 * 3600, '3h ago'],
    [2 * 86400, '2d ago'],
  ])('%is → %s', (sec, out) => {
    expect(timeAgo(ago(sec as number))).toBe(out);
  });

  it('returns empty string when the date cannot be read', () => {
    const spy = jest.spyOn(global, 'Date').mockImplementationOnce(() => { throw new Error('bad'); });
    expect(timeAgo('whatever')).toBe('');
    spy.mockRestore();
  });
});

describe('tierLabel', () => {
  it('maps tiers and passes unknown through', () => {
    expect(tierLabel('PRIMARY')).toBe('VIRAL');
    expect(tierLabel('BACKUP')).toBe('POTENTIAL');
    expect(tierLabel('SKIP')).toBe('SKIP');
    expect(tierLabel('OTHER')).toBe('OTHER');
  });
});

describe('videoLabel', () => {
  it('uses host + path for URLs', () => {
    expect(videoLabel(video('https://www.youtube.com/watch'))).toBe('www.youtube.com/watch');
  });
  it('falls back to the raw string for malformed http URLs', () => {
    expect(videoLabel(video('http://[bad'))).toBe('http://[bad');
  });
  it('uses a non-http source as-is, else the short id', () => {
    expect(videoLabel(video('/local/file.mp4'))).toBe('/local/file.mp4');
    expect(videoLabel(video(null))).toBe('abcdef12');
  });
});
