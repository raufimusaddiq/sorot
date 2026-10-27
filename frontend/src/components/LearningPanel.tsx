// The Learning app: log how posted clips did, see what's logged, and retrain
// the scoring once there are enough results. Everything needed is on this
// screen; nothing sends you hunting for a button on a clip card.

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';
import type { VideoGroup } from '@/types';
import { Window } from './Window';
import { ResultsForm } from './ResultsForm';

export const RESULTS_TO_TRAIN = 5;

export type LearningStats = { version: number; trained_on: number; total_feedback: number; with_actual_scores: number };

type LoggedResult = {
  clipId: string; title: string | null; viralScore: number | null;
  views: number; likes: number; comments: number; shares: number; saves: number; postedAt: string | null;
};

const count = (n: number) => n.toLocaleString('id-ID');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '-');

export function LearningPanel({ api, groups, stats, onStats }: {
  api: ApiClient;
  groups: VideoGroup[];
  stats: LearningStats | null;
  onStats: (s: LearningStats) => void;
}) {
  const [results, setResults] = useState<LoggedResult[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [trained, setTrained] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listFeedback() as { results: LoggedResult[] };
      setResults(data.results || []);
    } catch (e) { reportError(e, 'feedback.list'); }
    try {
      const ws = await api.getWeightsStatus() as LearningStats;
      onStats({ version: ws.version, trained_on: ws.trained_on, total_feedback: ws.total_feedback, with_actual_scores: ws.with_actual_scores });
    } catch (e) { reportError(e, 'feedback.weights'); }
  }, [api, onStats]);

  useEffect(() => { void refresh(); }, [refresh]);

  const logged = new Set(results.map(r => r.clipId));
  // Clips you could have posted: exported ones, best first, without a logged result yet.
  const waiting = groups
    .flatMap(g => g.clips.filter(c => c.exportPath && !logged.has(c.id)).map(c => ({ clip: c, video: g.video })))
    .sort((a, b) => (b.clip.score ?? 0) - (a.clip.score ?? 0));
  const have = stats?.with_actual_scores ?? 0;
  const ready = have >= RESULTS_TO_TRAIN;

  const train = async () => {
    setTraining(true);
    setTrained(null);
    try {
      await api.trainWeights();
      await refresh();
      setTrained('Scoring retrained on your results.');
    } catch (e) { reportError(e, 'feedback.train'); }
    finally { setTraining(false); }
  };

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-start">
      <div className="grid grid-cols-1 gap-8 min-w-0">
      <Window title="Learning" bar="bg-sun">
        <h2 className="heading text-[28px] mb-3">Teach Sorot what works</h2>
        <p className="text-sm text-fg mb-5">
          Log how a posted clip did. With {RESULTS_TO_TRAIN} results, Sorot can retrain its 13 scoring signals
          toward what your audience actually watches.
        </p>
        <div className="mb-2 flex gap-1.5" role="img" aria-label={`${Math.min(have, RESULTS_TO_TRAIN)} of ${RESULTS_TO_TRAIN} results logged`}>
          {Array.from({ length: RESULTS_TO_TRAIN }, (_, i) => (
            <span key={i} className={`h-8 flex-1 border-3 border-line rounded ${i < have ? 'bg-mint' : 'bg-surface-2'}`} />
          ))}
        </div>
        <p className="font-pixel text-sm mb-5">
          {have} of {RESULTS_TO_TRAIN} results logged{ready ? ' · ready to retrain' : ''}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={train} disabled={training || !ready} className="btn btn-primary px-5 py-2 text-sm">
            {training ? 'Retraining…' : 'Retrain scoring'}
          </button>
          {!ready && <span className="text-xs text-muted">Log {RESULTS_TO_TRAIN - have} more to retrain.</span>}
          {trained && <span className="text-xs font-semibold text-success">{trained}</span>}
        </div>
        {stats && (
          <p className="text-xs text-muted mt-5">
            Scoring version v{stats.version}{stats.trained_on > 0 ? `, last retrained on ${stats.trained_on} results` : ', not retrained yet'}.
          </p>
        )}
      </Window>

      <Window title="Logged results" bar="bg-mint" right={`${results.length}`} bodyClassName="">
        {results.length === 0 ? (
          <p className="p-5 text-sm text-muted">Nothing logged yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="font-pixel text-xs text-left">
              <tr className="border-b-3 border-line">
                <th className="px-4 py-2 font-normal">Clip</th>
                <th className="px-2 py-2 font-normal">Posted</th>
                <th className="px-2 py-2 font-normal text-right">Views</th>
                <th className="px-4 py-2 font-normal text-right">Viral score</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => (
                <tr key={r.clipId} className="border-b-2 border-dashed border-line last:border-b-0">
                  <td className="px-4 py-2 max-w-[16rem] truncate">{r.title || r.clipId.slice(0, 8)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{day(r.postedAt)}</td>
                  <td className="px-2 py-2 text-right font-pixel">{count(r.views)}</td>
                  <td className="px-4 py-2 text-right font-pixel">{r.viralScore === null ? '-' : `${(r.viralScore * 100).toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Window>
      </div>

      <div className="grid grid-cols-1 gap-8 min-w-0">
        <Window title="Waiting for results" bar="bg-aqua" right={`${waiting.length} clips`} bodyClassName="">
          {waiting.length === 0 ? (
            <p className="p-5 text-sm text-muted">
              Download a clip in the Library, post it, then come back here to log how it did.
            </p>
          ) : (
            <ul>
              {waiting.slice(0, 12).map(({ clip, video }) => (
                <li key={clip.id} className="border-b-2 border-dashed border-line last:border-b-0 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{clip.title || clip.textContent || `Clip #${clip.rankPos}`}</p>
                      <p className="text-xs text-muted truncate">{video.title || video.sourceUrl}</p>
                    </div>
                    <button onClick={() => setOpen(open === clip.id ? null : clip.id)} aria-expanded={open === clip.id}
                      className={`btn ${open === clip.id ? 'bg-accent text-white' : 'bg-sun'}`}>
                      {open === clip.id ? 'Close' : 'Log results'}
                    </button>
                  </div>
                  {open === clip.id && (
                    <div className="mt-3">
                      <ResultsForm api={api} clipId={clip.id} onSaved={() => { setOpen(null); void refresh(); }} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Window>

      </div>
    </div>
  );
}
