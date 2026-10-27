import { render, screen } from '@testing-library/react';
import { ProgressBar, ScoreBadge, TranscriptView } from '../progress';
import type { Clip, StageStatus } from '@/types';

const stage = (name: string, status: string, outputPath?: string): StageStatus =>
  ({ id: name, jobId: 'j', stage: name, status, startedAt: null, completedAt: null, outputPath });

describe('ProgressBar', () => {
  it('shows the current stage, percentage, render progress and per-stage markers', () => {
    render(<ProgressBar stages={[
      stage('IMPORT', 'COMPLETED'), stage('AUDIO_EXTRACT', 'COMPLETED'), stage('TRANSCRIBE', 'COMPLETED'),
      stage('RENDER', 'IN_PROGRESS', 'Rendering 3/8 clips'), stage('SUBTITLE', 'FAILED'),
    ]} />);
    expect(screen.getByText('Render Clips', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.getByText('Rendering 3/8 clips')).toBeInTheDocument();
    expect(screen.getByTitle('Import Video')).toHaveTextContent('✓');
    expect(screen.getByTitle('Render Clips')).toHaveTextContent('●');
    expect(screen.getByTitle('Add Subtitles')).toHaveTextContent('✗');
    expect(screen.getByTitle('Analytics')).toHaveTextContent('○');
  });

  it('shows Waiting… with no active stage; unknown current stage falls back to its key', () => {
    const { rerender } = render(<ProgressBar stages={[]} />);
    expect(screen.getByText('Waiting…')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    rerender(<ProgressBar stages={[stage('MYSTERY', 'RUNNING')]} />);
    expect(screen.getByText('MYSTERY')).toBeInTheDocument();
  });
});

describe('ScoreBadge', () => {
  it('renders nothing for null and colours by band', () => {
    const { container, rerender } = render(<ScoreBadge score={null} label="Hook" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ScoreBadge score={0.75} label="Hook" />);
    expect(screen.getByText('75%')).toHaveClass('text-success');
    rerender(<ScoreBadge score={0.5} label="Hook" />);
    expect(screen.getByText('50%')).toHaveClass('text-warning');
    rerender(<ScoreBadge score={0.1} label="Hook" />);
    expect(screen.getByText('10%')).toHaveClass('text-error');
  });
});

describe('TranscriptView', () => {
  const clip = (id: string, tier: string, extra: Partial<Clip> = {}): Clip => ({
    id, videoId: 'v', rankPos: 1, score: 0.81, tier, startTime: 65, endTime: 90, durationSec: 25,
    textContent: `text ${id}`, title: null, description: null, renderStatus: 'PENDING', renderPath: null,
    exportStatus: 'PENDING', exportPath: null, createdAt: '', ...extra,
  });

  it('filters by tier and shows the empty state', () => {
    const clips = [clip('a', 'PRIMARY'), clip('b', 'SKIP', { rankPos: null, score: null, textContent: null, tier: 'ODD' })];
    const { rerender } = render(<TranscriptView clips={clips} filterTier="ALL" />);
    expect(screen.getByText('text a')).toBeInTheDocument();
    expect(screen.getByText('81%')).toBeInTheDocument();
    expect(screen.getAllByText('1:05 → 1:30 (25.0s)')).toHaveLength(2);
    expect(screen.getByText('No transcript available')).toBeInTheDocument();
    expect(screen.getByText('#-')).toBeInTheDocument();
    rerender(<TranscriptView clips={clips} filterTier="BACKUP" />);
    expect(screen.getByText('No clips to show.')).toBeInTheDocument();
  });
});
