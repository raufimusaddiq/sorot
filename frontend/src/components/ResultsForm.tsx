// Log how a posted clip performed. Used on each clip card and in the Learning
// app; the viral score it returns is velocity-based, so the post time is required.

import { useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';

const METRICS = [
  ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'],
] as const;

type Metric = (typeof METRICS)[number][0];

export function ResultsForm({ api, clipId, onSaved }: {
  api: ApiClient;
  clipId: string;
  onSaved?: (viralScore: number) => void;
}) {
  const [values, setValues] = useState<Record<Metric, string>>({ views: '', likes: '', comments: '', shares: '', saves: '' });
  // datetime-local format (yyyy-MM-ddTHH:mm) in the browser's local tz; converted to ISO-8601 UTC on submit.
  const [postedAt, setPostedAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viralScore, setViralScore] = useState<number | null>(null);

  const submit = async () => {
    setError(null);
    if (!postedAt) {
      setError('Isi tanggal upload dulu — viral score butuh durasi di platform.');
      return;
    }
    const posted = new Date(postedAt);
    if (Number.isNaN(posted.getTime())) {
      setError('Format tanggal tidak valid.');
      return;
    }
    if (posted.getTime() > Date.now()) {
      setError('Tanggal upload tidak boleh di masa depan.');
      return;
    }
    setSubmitting(true);
    try {
      const n = (k: Metric) => parseInt(values[k]) || 0;
      const result = await api.submitFeedback(clipId, {
        views: n('views'), likes: n('likes'), comments: n('comments'), shares: n('shares'), saves: n('saves'),
        postedAt: posted.toISOString(),
      }) as { viralScore: number };
      setViralScore(result.viralScore);
      onSaved?.(result.viralScore);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal submit feedback');
      reportError(e, 'submitFeedback');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs text-muted font-medium block" htmlFor={`posted-${clipId}`}>
          Tanggal & jam upload
          <span className="text-accent ml-1">*</span>
        </label>
        <input
          id={`posted-${clipId}`}
          type="datetime-local"
          value={postedAt}
          onChange={e => setPostedAt(e.target.value)}
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
          {METRICS.map(([key, label]) => (
            <input key={key} type="number" placeholder={label} aria-label={label} value={values[key]}
              onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))}
              className="field px-2 py-1 text-xs w-full" />
          ))}
        </div>
      </div>
      {error && (
        <p className="text-xs text-fg font-semibold bg-error-tint border-2 border-line rounded px-2 py-1">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={submitting} className="btn btn-primary">
          {submitting ? 'Saving...' : 'Submit feedback'}
        </button>
        {viralScore !== null && (
          <span className="text-xs font-pixel text-success">Viral Score: {(viralScore * 100).toFixed(1)}%</span>
        )}
      </div>
    </div>
  );
}
