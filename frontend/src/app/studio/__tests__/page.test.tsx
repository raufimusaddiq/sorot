import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Studio from '@/app/studio/page';
import {
  emptyState, installFakeApi, makeCandidate, makeClip, makeConnections, makeJob, makeScore, makeStages, makeVideo, ts,
  type FakeState,
} from '../../../../test/fakeApi';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
  window.confirm = jest.fn(() => true);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const calls = (method: string, path: string) => fake.calls.filter(c => c.method === method && c.path === path);

async function renderLoaded() {
  const utils = render(<Studio />);
  await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
  return utils;
}

/** The ClipCard root for a clip (cards are identified by their transcript text). */
const card = (clipId: string) => screen.getByText(`teks ${clipId}`).closest('[data-clip-card]') as HTMLElement;

/** One COMPLETED video with three clips covering ClipCard's render branches. */
function seedCompleted() {
  state.videos = [makeVideo('v1', { title: 'Portal Ghaib' })];
  state.jobs = [makeJob('j1', 'v1', 'COMPLETED', { currentStage: 'ANALYTICS' })];
  state.stages.j1 = makeStages('j1', 9);
  state.clips.v1 = [
    makeClip('c1', 'v1', 'PRIMARY', 1, { exportPath: '/data/exports/c1.mp4', exportStatus: 'COMPLETED' }),
    makeClip('c2', 'v1', 'BACKUP', 2),
    makeClip('c3', 'v1', 'BACKUP', 3, {
      rankPos: null, score: null, title: null, description: null, renderPath: null, renderStatus: 'PENDING',
    }),
  ];
  state.scores.c1 = makeScore('c1');
}

describe('shell', () => {
  it('renders title, tabs and the import form', async () => {
    await renderLoaded();
    expect(screen.getByText('Sorot')).toBeInTheDocument();
    expect(screen.getByText(/vertical clips with word-timed captions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import & clips/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import & process/i })).toBeDisabled();
    expect(screen.getByText('No videos yet. Import a YouTube URL above to get started.')).toBeInTheDocument();
  });

  it('shows a loading state before data arrives', () => {
    render(<Studio />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});

describe('loading the library', () => {
  it('groups videos with their job, clips and scores; auto-expands the newest with clips', async () => {
    seedCompleted();
    await renderLoaded();

    expect(screen.getByText('Videos (1)')).toBeInTheDocument();
    expect(screen.getByText('Portal Ghaib')).toBeInTheDocument();
    expect(screen.getByText('3 clips')).toBeInTheDocument();
    expect(screen.getByText('1 viral')).toBeInTheDocument();
    expect(screen.getByText('2 potential')).toBeInTheDocument();
    expect(screen.getByText('Clips (3)')).toBeInTheDocument(); // expanded
    expect(calls('GET', '/api/clips/c1')).toHaveLength(1);

    // collapse / expand
    fireEvent.click(screen.getByText('Collapse'));
    expect(screen.queryByText('Clips (3)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Expand'));
    expect(screen.getByText('Clips (3)')).toBeInTheDocument();
  });

  it('renders the per-video states: unprocessed, empty, failed, cancelled, unknown', async () => {
    state.videos = [
      makeVideo('vNoJob', { title: null, sourceUrl: null, createdAt: ts(500) }),
      makeVideo('vEmpty', { createdAt: ts(400) }),
      makeVideo('vFail', { title: null, createdAt: ts(300) }),
      makeVideo('vFail2', { createdAt: ts(200) }),
      makeVideo('vOdd', { createdAt: ts(100) }),
    ];
    state.jobs = [
      makeJob('jEmpty', 'vEmpty', 'COMPLETED', { createdAt: ts(399) }),
      makeJob('jFail', 'vFail', 'FAILED', { errorMessage: 'Stage SCORE failed: OOM', createdAt: ts(299) }),
      makeJob('jFail2', 'vFail2', 'FAILED', { createdAt: ts(199) }),
      makeJob('jOdd', 'vOdd', 'WEIRD', { createdAt: ts(99) }),
    ];
    await renderLoaded();

    const headers = screen.getAllByText(/Expand$/).map(e => e.closest('button') as HTMLElement);
    expect(headers).toHaveLength(5);
    // newest first by job (or video) date
    expect(headers[0]).toHaveTextContent('Video vOdd');
    expect(headers[4]).toHaveTextContent('vNoJob'.slice(0, 8));
    expect(headers[4]).toHaveTextContent('No job');
    expect(headers[2]).toHaveTextContent('https://youtu.be/vFail');

    headers.forEach(h => fireEvent.click(h));
    expect(screen.getByText('Video imported but not processed yet.')).toBeInTheDocument();
    expect(screen.getByText(/Pipeline completed but no clips were generated/)).toBeInTheDocument();
    expect(screen.getAllByText('Pipeline Failed')).toHaveLength(2);
    expect(screen.getByText('Stage SCORE failed: OOM')).toBeInTheDocument();
    expect(screen.getByText('Unknown error')).toBeInTheDocument();
  });

  it('reports each failing load step without crashing', async () => {
    seedCompleted();
    state.fail['GET /api/jobs/j1'] = 'job gone';
    state.fail['GET /api/clips/c1'] = 'clip gone';
    state.fail['GET /api/feedback/weights'] = 'no weights';
    await renderLoaded();
    expect(console.error).toHaveBeenCalledWith('[getJob]', expect.any(Error));
    expect(console.error).toHaveBeenCalledWith('[getClip]', expect.any(Error));
    expect(console.error).toHaveBeenCalledWith('[getWeightsStatus]', expect.any(Error));
    expect(screen.getByText('Portal Ghaib')).toBeInTheDocument();
  });

  it('a failing clip list or library list surfaces in the error banner', async () => {
    seedCompleted();
    state.fail['GET /api/videos/v1/clips'] = 'clips down';
    const first = await renderLoaded();
    expect(await screen.findByText('fetchClipsForVideo')).toBeInTheDocument();
    first.unmount();

    state.fail['GET /api/videos'] = 'db down';
    await renderLoaded();
    expect(await screen.findByText('loadAllData')).toBeInTheDocument();
    expect(screen.getByText('db down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText('db down')).not.toBeInTheDocument();
  });
});

describe('clip list', () => {
  beforeEach(seedCompleted);

  it('filters by tier, switches to transcript, and shows the empty-filter message', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'VIRAL' }));
    expect(screen.getByText('teks c1')).toBeInTheDocument();
    expect(screen.queryByText('teks c2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SKIP' }));
    expect(screen.getByText('No clips match this filter.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(screen.getByText('teks c3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clips (3)' }));
    expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(2);
  });

  it('renders card details: rank, score, download link, export button, unrendered fallback', async () => {
    await renderLoaded();
    const c1 = card('c1');
    expect(within(c1).getByText('#1')).toBeInTheDocument();
    expect(within(c1).getByText('80')).toBeInTheDocument();
    expect(within(c1).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/clips/c1/export');
    expect(within(card('c2')).getByRole('button', { name: 'Export' })).toBeInTheDocument();
    const c3 = card('c3');
    expect(within(c3).getByText('#-')).toBeInTheDocument();
    expect(within(c3).getByText('-')).toBeInTheDocument();
    expect(within(c3).queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(within(c3).queryByLabelText('Select clip')).not.toBeInTheDocument();
  });

  it('toggles the score breakdown', async () => {
    await renderLoaded();
    const c1 = card('c1');
    fireEvent.click(within(c1).getByRole('button', { name: 'Score' }));
    expect(within(c1).getByText('Hook')).toBeInTheDocument();
    expect(within(c1).getByText('Boost +5%')).toBeInTheDocument();
    expect(within(c1).getByText('Penalty -2%')).toBeInTheDocument();
    expect(within(c1).queryByText('Scenes')).not.toBeInTheDocument(); // null score hidden
    fireEvent.click(within(c1).getByRole('button', { name: 'Hide' }));
    expect(within(c1).queryByText('Hook')).not.toBeInTheDocument();
  });

  it('copies title and description, then resets the label', async () => {
    jest.useFakeTimers();
    await renderLoaded();
    const c1 = card('c1');
    fireEvent.click(within(c1).getByRole('button', { name: 'Copy' })); // open meta panel
    const [copyTitle, copyDesc] = within(c1).getAllByRole('button', { name: 'Copy' });
    await act(async () => { fireEvent.click(copyTitle!); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Judul c1');
    expect(within(c1).getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(copyDesc!); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Deskripsi c1');
    act(() => { jest.advanceTimersByTime(1600); });
    expect(within(c1).queryByRole('button', { name: 'Copied!' })).not.toBeInTheDocument();
    fireEvent.click(within(c1).getByRole('button', { name: 'Hide' }));
    expect(within(c1).queryByText('Description')).not.toBeInTheDocument();
  });

  it('meta panel shows only the fields a clip has', async () => {
    state.clips.v1![1] = makeClip('c2', 'v1', 'BACKUP', 2, { title: null });
    state.clips.v1![0] = makeClip('c1', 'v1', 'PRIMARY', 1, { description: null });
    await renderLoaded();
    fireEvent.click(within(card('c2')).getByRole('button', { name: 'Copy' }));
    expect(within(card('c2')).queryByText('Title')).not.toBeInTheDocument();
    expect(within(card('c2')).getByText('Description')).toBeInTheDocument();
    fireEvent.click(within(card('c1')).getByRole('button', { name: 'Copy' }));
    expect(within(card('c1')).queryByText('Description')).not.toBeInTheDocument();
  });

  it('exports a single clip and refreshes; a failed export is swallowed', async () => {
    await renderLoaded();
    state.fail['POST /api/clips/export'] = 'disk full';
    fireEvent.click(within(card('c2')).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(calls('POST', '/api/clips/export')).toHaveLength(1));
    expect(within(card('c2')).getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).not.toBeInTheDocument();

    delete state.fail['POST /api/clips/export'];
    fireEvent.click(within(card('c2')).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(within(card('c2')).getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(calls('POST', '/api/clips/export')[1]!.body).toEqual({ clipIds: ['c2'] });
  });

  it('selects clips, exports the selection, clears, and reports export failures', async () => {
    await renderLoaded();
    const select = (id: string) => fireEvent.click(within(card(id)).getByLabelText('Select clip'));

    select('c1'); select('c2'); select('c2'); // toggle c2 off again
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    select('c2');
    fireEvent.click(screen.getByRole('button', { name: 'Export Selected' }));
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    expect(calls('POST', '/api/clips/export').at(-1)!.body).toEqual({ clipIds: ['c2'] });

    state.fail['POST /api/clips/export'] = 'disk full';
    select('c1');
    fireEvent.click(screen.getByRole('button', { name: 'Export Selected' }));
    expect(await screen.findByText('exportClips')).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('opens the preview modal, toggles, handles playback errors, and closes', async () => {
    await renderLoaded();
    fireEvent.click(within(card('c1')).getByRole('button', { name: 'Preview' }));
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).toHaveAttribute('src', '/api/clips/c1/preview');
    expect(within(card('c1')).getByRole('button', { name: 'Playing...' })).toBeInTheDocument();
    fireEvent.error(video);
    expect(screen.getByText('Unable to play this clip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(document.querySelector('video')).toBeNull();

    fireEvent.click(within(card('c1')).getByRole('button', { name: 'Preview' }));
    fireEvent.click(within(card('c1')).getByRole('button', { name: 'Playing...' }));
    expect(document.querySelector('video')).toBeNull();
  });

  it('validates and submits post feedback', async () => {
    await renderLoaded();
    const c1 = card('c1');
    fireEvent.click(within(c1).getByRole('button', { name: 'Results' }));
    const submit = within(c1).getByRole('button', { name: 'Submit feedback' });

    fireEvent.click(submit);
    expect(within(c1).getByText(/Isi tanggal upload dulu/)).toBeInTheDocument();

    const dateInput = c1.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    fireEvent.change(dateInput, { target: { value: local(new Date(Date.now() + 2 * 86_400_000)) } });
    fireEvent.click(submit);
    expect(within(c1).getByText('Tanggal upload tidak boleh di masa depan.')).toBeInTheDocument();

    fireEvent.change(dateInput, { target: { value: local(new Date(Date.now() - 2 * 86_400_000)) } });
    for (const [ph, v] of [['Views', '1000'], ['Likes', '50'], ['Comments', '3'], ['Shares', '2'], ['Saves', 'x']]) {
      fireEvent.change(within(c1).getByPlaceholderText(ph!), { target: { value: v } });
    }
    fireEvent.click(submit);
    expect(await within(c1).findByText('Viral Score: 42.0%')).toBeInTheDocument();
    expect(within(c1).getByRole('button', { name: '42%' })).toBeInTheDocument();
    const body = calls('POST', '/api/clips/c1/feedback')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ views: 1000, likes: 50, comments: 3, shares: 2, saves: 0 });
    expect(String(body.postedAt)).toMatch(/Z$/);

    state.fail['POST /api/clips/c1/feedback'] = 'postedAt is in the future';
    fireEvent.click(submit);
    expect(await within(c1).findByText('postedAt is in the future')).toBeInTheDocument();
    expect(await screen.findByText('submitFeedback')).toBeInTheDocument();

    fireEvent.click(within(c1).getByRole('button', { name: '42%' }));
    expect(within(c1).queryByRole('button', { name: 'Submit feedback' })).not.toBeInTheDocument();
  });

  it('deletes a finished video after confirmation only', async () => {
    await renderLoaded();
    (window.confirm as jest.Mock).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls('DELETE', '/api/videos/v1')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No videos yet. Import a YouTube URL above to get started.')).toBeInTheDocument();
    expect(calls('DELETE', '/api/videos/v1')).toHaveLength(1);
  });

  it('reports a failed delete', async () => {
    state.fail['DELETE /api/videos/v1'] = 'locked';
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('deleteVideo')).toBeInTheDocument();
  });
});

describe('running jobs and polling', () => {
  function seedRunning() {
    state.videos = [makeVideo('v1')];
    state.jobs = [makeJob('j1', 'v1', 'RUNNING', { currentStage: 'TRANSCRIBE', errorMessage: 'retrying whisper' })];
    state.stages.j1 = makeStages('j1', 2, 'TRANSCRIBE');
  }

  it('resumes polling for a job that was already running on load', async () => {
    jest.useFakeTimers();
    seedRunning();
    await renderLoaded();

    expect(screen.getByRole('button', { name: 'Processing...' })).toBeDisabled();
    expect(screen.getByText('22% complete')).toBeInTheDocument();
    expect(screen.getByText('retrying whisper')).toBeInTheDocument();
    const before = calls('GET', '/api/jobs/j1').length;

    // stage transition, then completion with clips
    state.jobs[0] = { ...state.jobs[0]!, currentStage: 'SCORE' };
    state.stages.j1 = makeStages('j1', 4, 'SCORE');
    await act(async () => { await jest.advanceTimersByTimeAsync(2_100); });
    expect(calls('GET', '/api/jobs/j1').length).toBeGreaterThan(before);
    expect(screen.getByText('44% complete')).toBeInTheDocument();

    state.jobs[0] = { ...state.jobs[0]!, status: 'COMPLETED', currentStage: 'ANALYTICS', errorMessage: null };
    state.stages.j1 = makeStages('j1', 9);
    state.clips.v1 = [makeClip('c1', 'v1', 'PRIMARY', 1)];
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText('teks c1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import & Process' })).toBeInTheDocument();

    const settled = fake.calls.length;
    await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
    expect(fake.calls.length).toBe(settled); // polling stopped
  });

  it('stops polling and shows the error when the job fails', async () => {
    jest.useFakeTimers();
    seedRunning();
    await renderLoaded();
    state.jobs[0] = { ...state.jobs[0]!, status: 'FAILED', errorMessage: 'Stage TRANSCRIBE failed: CUDA OOM' };
    await act(async () => { await jest.advanceTimersByTimeAsync(2_100); });
    fireEvent.click(screen.getByText('Collapse').closest('button')!);
    fireEvent.click(screen.getByText('Expand').closest('button')!);
    expect(screen.getByText('Stage TRANSCRIBE failed: CUDA OOM')).toBeInTheDocument();
    expect(screen.getByText('Pipeline Failed')).toBeInTheDocument();
  });

  it('keeps polling through errors; aborted polls are not reported', async () => {
    jest.useFakeTimers();
    seedRunning();
    await renderLoaded();
    (console.error as jest.Mock).mockClear();

    state.fail['GET /api/jobs/j1'] = '__abort__';
    await act(async () => { await jest.advanceTimersByTimeAsync(2_100); });
    expect(console.error).not.toHaveBeenCalled();

    state.fail['GET /api/jobs/j1'] = 'backend restarting';
    await act(async () => { await jest.advanceTimersByTimeAsync(4_100); });
    expect(console.error).toHaveBeenCalledWith('[pollJob]', expect.any(Error));

    delete state.fail['GET /api/jobs/j1'];
    const n = calls('GET', '/api/jobs/j1').length;
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(calls('GET', '/api/jobs/j1').length).toBeGreaterThan(n);
  });

  it('cancels a running job and stops polling once the job reports CANCELLED', async () => {
    jest.useFakeTimers();
    seedRunning();
    await renderLoaded();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(calls('POST', '/api/jobs/j1/cancel')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();

    // Regression: a CANCELLED job used to keep the poller (and "Processing...") alive forever.
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole('button', { name: 'Import & Process' })).toBeInTheDocument();
    const settled = calls('GET', '/api/jobs/j1').length;
    await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
    expect(calls('GET', '/api/jobs/j1')).toHaveLength(settled);
  });

  it('reports a failed cancel', async () => {
    seedRunning();
    state.fail['POST /api/jobs/j1/cancel'] = 'not running';
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('cancelJob')).toBeInTheDocument();
  });

  it('treats a QUEUED job as active and shows the progress panel only when expanded', async () => {
    state.videos = [makeVideo('v1')];
    state.jobs = [makeJob('j1', 'v1', 'QUEUED')];
    state.stages.j1 = makeStages('j1', 0);
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Processing...' })).toBeDisabled();
    expect(screen.getByText('Waiting…')).toBeInTheDocument();
  });
});

describe('import', () => {
  it('imports, starts processing, polls to completion and shows the clips', async () => {
    jest.useFakeTimers();
    await renderLoaded();
    const input = screen.getByPlaceholderText('Paste YouTube URL...');
    fireEvent.change(input, { target: { value: '  https://youtu.be/abc  ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import & Process' })); });

    expect(calls('POST', '/api/import')[0]!.body).toEqual({ url: 'https://youtu.be/abc' });
    expect(calls('POST', '/api/process')[0]!.body).toEqual({ videoId: 'vnew', options: {} });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Processing...' })).toBeInTheDocument());
    expect(input).toHaveValue('');
    expect(calls('GET', '/api/jobs/jnew').length).toBeGreaterThan(0);

    state.jobs[0] = { ...state.jobs[0]!, status: 'COMPLETED' };
    state.clips.vnew = [makeClip('c9', 'vnew', 'PRIMARY', 1)];
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText('teks c9')).toBeInTheDocument();
  });

  it('shows the import error and ignores blank input', async () => {
    state.fail['POST /api/import'] = 'Invalid URL';
    await renderLoaded();
    const input = screen.getByPlaceholderText('Paste YouTube URL...');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(calls('POST', '/api/import')).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import & Process' }));
    expect(await screen.findByText('Invalid URL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import & Process' })).toBeEnabled();
  });
});

describe('learning app', () => {
  const openLearning = async (name: string) => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name }));
  };

  it('shows progress toward retraining in plain words; training stays off below five', async () => {
    state.weights = { version: 3, trained_on: 0, total_feedback: 4, with_actual_scores: 2 };
    await openLearning('Learning (2)');
    expect(await screen.findByText('2 of 5 results logged')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2 of 5 results logged' })).toBeInTheDocument();
    expect(screen.getByText('Log 3 more to retrain.')).toBeInTheDocument();
    expect(screen.getByText('Scoring version v3, not retrained yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retrain scoring' })).toBeDisabled();
    expect(screen.getByText('Nothing logged yet.')).toBeInTheDocument();
  });

  it('logs results for a downloaded clip right here, then lists them', async () => {
    seedCompleted();
    state.clips.v1 = state.clips.v1!.map(c => (c.id === 'c1' ? { ...c, title: 'Downloaded one' } : c));
    await openLearning('Learning');
    const waiting = await screen.findByRole('region', { name: 'Waiting for results' });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Log results' }));
    const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    fireEvent.change(waiting.querySelector('input[type="datetime-local"]')!, { target: { value: local(new Date(Date.now() - 86_400_000)) } });
    fireEvent.change(within(waiting).getByPlaceholderText('Views'), { target: { value: '1200' } });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Submit feedback' }));
    const logged = screen.getByRole('region', { name: 'Logged results' });
    expect(await within(logged).findByText('Downloaded one')).toBeInTheDocument();
    expect(within(logged).getByText('42%')).toBeInTheDocument();
    expect(within(logged).getByText((1200).toLocaleString('id-ID'))).toBeInTheDocument();
    expect(await within(waiting).findByText(/Download a clip in the Library/)).toBeInTheDocument();
    expect(screen.getByText('1 of 5 results logged')).toBeInTheDocument();
  });

  it('retrains when ready and says so; failures are reported', async () => {
    state.weights = { version: 3, trained_on: 0, total_feedback: 6, with_actual_scores: 6 };
    state.results = [{ clipId: 'gone-clip-id', title: null, viralScore: null, views: 5, likes: 0, comments: 0, shares: 0, saves: 0, postedAt: null }];
    await openLearning('Learning (6)');
    expect(await screen.findByText(/ready to retrain/)).toBeInTheDocument();
    expect(await screen.findByText('gone-cli')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retrain scoring' }));
    expect(await screen.findByText('Scoring retrained on your results.')).toBeInTheDocument();
    expect(screen.getByText('Scoring version v4, last retrained on 6 results.')).toBeInTheDocument();

    state.fail['POST /api/feedback/train'] = 'not enough data';
    fireEvent.click(screen.getByRole('button', { name: 'Retrain scoring' }));
    expect(await screen.findByText('feedback.train')).toBeInTheDocument();
  });

  it('a broken feedback API leaves the screen usable', async () => {
    state.fail['GET /api/feedback/weights'] = 'no model';
    state.fail['GET /api/feedback'] = 'db locked';
    await openLearning('Learning');
    expect(await screen.findByText(/feedback.(list|weights)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retrain scoring' })).toBeDisabled();
    expect(screen.queryByText(/Scoring version/)).not.toBeInTheDocument();
  });
});

describe('discovery panel', () => {
  const openDiscovery = async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
  };
  const row = (title: string) => screen.getByText(title).closest('[data-candidate]') as HTMLElement;

  it('shows the empty states per filter', async () => {
    await openDiscovery();
    expect(await screen.findByText('No candidates yet. Run a search above to populate.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Queued' }));
    expect(await screen.findByText('No queued videos.')).toBeInTheDocument();
    expect(fake.calls.some(c => c.path === '/api/discover/candidates')).toBe(true);
  });

  it('runs search, trending and channel discovery; blank input is ignored', async () => {
    await openDiscovery();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    // [0] is the panel's submit button; [1] is the "Discover" app in the dock.
    const discover = screen.getAllByRole('button', { name: /^Discover$/ })[0]!;

    const search = screen.getByPlaceholderText(/Search keywords/);
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.change(search, { target: { value: ' fakta unik ' } });
    fireEvent.keyDown(search, { key: 'a' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(calls('POST', '/api/discover/search')).toHaveLength(1));
    expect(calls('POST', '/api/discover/search')[0]!.body).toMatchObject({ query: 'fakta unik' });

    fireEvent.click(screen.getByRole('button', { name: 'Trending' }));
    expect(screen.getByText('Fetches current Indonesian trending videos')).toBeInTheDocument();
    fireEvent.click(discover);
    await waitFor(() => expect(calls('POST', '/api/discover/trending')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Channel' }));
    const channel = screen.getByPlaceholderText(/YouTube channel URL/);
    fireEvent.click(discover);
    fireEvent.change(channel, { target: { value: 'https://youtube.com/@x' } });
    fireEvent.keyDown(channel, { key: 'Enter' });
    await waitFor(() => expect(calls('POST', '/api/discover/channel')).toHaveLength(1));
  });

  it('auto-discover follows the run, then shows picks with their reasons', async () => {
    jest.useFakeTimers();
    try {
      const steps = [{ tool: 'web_search', args: { query: 'viral' }, result: '6 results' }];
      const base = { id: 'r1', mode: null, model: null, notes: null, llmError: null, error: null, count: 0 };
      state.autoRuns = [
        { ...base, status: 'RUNNING', steps },
        { ...base, status: 'RUNNING', steps: [...steps, { tool: 'source_channels', args: {}, result: '2 results' }] },
        { ...base, status: 'DONE', mode: 'agent', model: 'qwen', notes: 'Sidang X', count: 1, steps },
      ];
      await openDiscovery();
      expect(screen.getByText(/reads the whole captions/)).toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText(/Optional focus/), { target: { value: ' drama ' } });
      fireEvent.keyDown(screen.getByPlaceholderText(/Optional focus/), { key: 'Enter' });
      await waitFor(() => expect(calls('POST', '/api/discover/auto')[0]!.body).toEqual({ goal: 'drama', maxResults: 10 }));
      expect(await screen.findByText('web_search viral → 6 results')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Researching…' })).toBeDisabled();

      state.candidates = [
        makeCandidate('9', 'NEW', { title: 'Agent pick', sourceMode: 'auto', pickedBy: 'qwen', why: ['Hot topic', '3 strong moments, best at 4:38'] }),
        makeCandidate('8', 'NEW', { title: 'Algo pick', sourceMode: 'auto', pickedBy: 'algorithm' }),
        makeCandidate('7', 'NEW', { title: 'Re-found by search', sourceMode: 'search', pickedBy: 'algorithm' }),
      ];
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText('source_channels → 2 results')).toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText('Picked 1 by qwen')).toBeInTheDocument();
      expect(screen.getByText('Trend: Sidang X')).toBeInTheDocument();
      const pick = row('Agent pick');
      expect(within(pick).getByText('Hot topic')).toBeInTheDocument();
      expect(within(pick).getByText('3 strong moments, best at 4:38')).toBeInTheDocument();
      expect(within(pick).getByTitle('Picked by the LLM agent (qwen)')).toHaveTextContent('🤖 qwen');
      expect(within(row('Algo pick')).getByTitle('Picked by the algorithm (no LLM)')).toHaveTextContent('algorithm');
      expect(within(row('Re-found by search')).queryByTitle(/Picked by/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Auto-discover' })).toBeEnabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('auto-discover: algorithm fallback, failed run, start and poll errors', async () => {
    jest.useFakeTimers();
    try {
      const base = { id: 'r1', mode: 'algorithm', model: null, notes: null, error: null, count: 2, steps: [] };
      state.autoRuns = [{ ...base, status: 'DONE', llmError: 'No LLM configured' }];
      await openDiscovery();
      fireEvent.click(screen.getByRole('button', { name: 'Auto-discover' }));
      expect(await screen.findByText('Picked 2 by the algorithm')).toBeInTheDocument();
      expect(screen.getByText(/— No LLM configured/)).toBeInTheDocument();

      state.autoRuns = [{ ...base, status: 'RUNNING', llmError: null }, { ...base, status: 'FAILED', llmError: null, error: 'boom' }];
      fireEvent.click(screen.getByRole('button', { name: 'Auto-discover' }));
      await screen.findByRole('button', { name: 'Researching…' });
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText('boom')).toBeInTheDocument();

      state.autoRuns = [{ ...base, status: 'RUNNING', llmError: null }, { ...base, status: 'FAILED', llmError: null, error: null }];
      fireEvent.click(screen.getByRole('button', { name: 'Auto-discover' }));
      await screen.findByRole('button', { name: 'Researching…' });
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText('Auto-discover failed')).toBeInTheDocument();

      state.autoRuns = [{ ...base, status: 'RUNNING', llmError: null }];
      state.fail['GET /api/discover/auto/*'] = 'gone';
      fireEvent.click(screen.getByRole('button', { name: 'Auto-discover' }));
      await screen.findByRole('button', { name: 'Researching…' });
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText('discover.autoStatus')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('auto-discover start errors show inline', async () => {
    state.fail['POST /api/discover/auto'] = 'Auto-discover already running: r0';
    await openDiscovery();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-discover' }));
    expect(await screen.findByText('Auto-discover already running: r0')).toBeInTheDocument();
  });

  it('shows discovery errors inline', async () => {
    state.fail['POST /api/discover/search'] = 'yt-dlp missing';
    await openDiscovery();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByPlaceholderText(/Search keywords/), { target: { value: 'x' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Discover$/ })[0]!);
    expect(await screen.findByText('yt-dlp missing')).toBeInTheDocument();
  });

  it('renders candidates with their score source and status; queue, drain, skip, unskip', async () => {
    state.candidates = [
      makeCandidate('1', 'NEW', { title: 'Hot one' }),
      makeCandidate('2', 'QUEUED', { title: 'Queued one', predictedScore: null, transcriptScore: 0.1, relevanceScore: 0.45 }),
      makeCandidate('3', 'NEW', { title: '', youtubeId: 'ytBare', predictedScore: null, transcriptScore: 0.2,
        relevanceScore: 0.1, viewCount: null, duration: 0, channel: '', sourceMode: '' }),
    ];
    await openDiscovery();
    expect(await screen.findByText('Hot one')).toBeInTheDocument();

    const hot = row('Hot one');
    expect(within(hot).getByText('70%')).toHaveClass('text-success');
    expect(within(hot).getByText('predicted')).toBeInTheDocument();
    expect(within(hot).getByText('12.0K views')).toBeInTheDocument();
    expect(within(hot).getByText('5:00')).toBeInTheDocument();
    const queued = row('Queued one');
    expect(within(queued).getByText('45%')).toHaveClass('text-warning');
    expect(within(queued).getByText('relevance')).toBeInTheDocument();
    expect(within(queued).queryByRole('checkbox')).not.toBeInTheDocument();
    const bare = row('ytBare');
    expect(within(bare).getByText('10%')).toHaveClass('text-subtle');
    expect(within(bare).queryByText(/views/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'To review (3)' })).toBeInTheDocument();

    // something already queued can be started on its own
    fireEvent.click(screen.getByRole('button', { name: 'Start 1 queued' }));
    await waitFor(() => expect(calls('POST', '/api/discover/queue/drain')).toHaveLength(1));

    // select → deselect → select → make clips (queues and starts in one step)
    const box = within(row('Hot one')).getByRole('checkbox', { name: 'Select Hot one' });
    fireEvent.click(box); fireEvent.click(box); fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Make clips from 1 selected' }));
    await waitFor(() => expect(calls('POST', '/api/discover/queue')[0]!.body).toEqual({ ids: ['1'] }));
    await waitFor(() => expect(calls('POST', '/api/discover/queue/drain')).toHaveLength(2));

    // skip the remaining NEW one, then unskip it from the SKIPPED filter
    fireEvent.click(within(row('ytBare')).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(state.candidates.find(c => c.id === '3')!.status).toBe('SKIPPED'));
    fireEvent.click(screen.getByRole('button', { name: 'Skipped' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unskip' }));
    await waitFor(() => expect(state.candidates.find(c => c.id === '3')!.status).toBe('NEW'));
  });

  it('badges each status; imported/skipped rows are dimmed and unselectable', async () => {
    state.candidatesListAll = true;
    state.candidates = [
      makeCandidate('7', 'SKIPPED', { title: 'Nope' }),
      makeCandidate('8', 'IMPORTED', { title: 'Done' }),
      makeCandidate('9', 'FAILED', { title: 'Broke' }),
    ];
    await openDiscovery();
    expect(await screen.findByText('Broke')).toBeInTheDocument();
    expect(within(row('Broke')).getByText('Failed')).toHaveClass('text-error');
    expect(row('Broke').className).not.toContain('opacity-60');
    expect(within(row('Done')).getByText('Imported')).toHaveClass('text-success');
    expect(row('Done').className).toContain('opacity-60');
    expect(within(row('Nope')).getByText('Skipped')).toHaveClass('text-subtle');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(row('Done')).queryByRole('button', { name: /Skip|Unskip/ })).not.toBeInTheDocument();
  });

  it('keeps the list short: three reasons a row, twenty rows, then "Show all"', async () => {
    state.candidates = Array.from({ length: 22 }, (_, i) => makeCandidate(String(i + 1), 'NEW', {
      title: `Video ${i + 1}`, why: i === 0 ? ['one', 'two', 'three', 'four', 'five'] : [],
    }));
    await openDiscovery();
    const first = await waitFor(() => row('Video 1'));
    expect(within(first).queryByText('four')).not.toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: '+2 more' }));
    expect(within(first).getByText('five')).toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: 'Less' }));
    expect(within(first).queryByText('five')).not.toBeInTheDocument();
    expect(screen.queryByText('Video 21')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 22' }));
    expect(screen.getByText('Video 22')).toBeInTheDocument();
  });

  it('polls while transcript enrichment is pending', async () => {
    jest.useFakeTimers();
    state.candidates = [makeCandidate('1', 'NEW', { title: 'Pending', transcriptScore: null, predictedScore: null })];
    await openDiscovery();
    expect(await screen.findByText('enriching…')).toBeInTheDocument();
    state.candidates = [makeCandidate('1', 'NEW', { title: 'Pending', transcriptScore: 0.5, predictedScore: 0.9 })];
    await act(async () => { await jest.advanceTimersByTimeAsync(3_100); });
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('reports failures of list, queue, drain, skip and unskip', async () => {
    state.candidates = [
      makeCandidate('1', 'NEW', { title: 'A' }),
      makeCandidate('2', 'QUEUED', { title: 'B' }),
      makeCandidate('3', 'SKIPPED', { title: 'C' }),
    ];
    await openDiscovery();
    await screen.findByText('A');
    state.fail['POST /api/discover/queue'] = 'q';
    state.fail['POST /api/discover/queue/drain'] = 'd';
    state.fail['POST /api/discover/candidates/*'] = 's';

    fireEvent.click(within(row('A')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Make clips from 1 selected' }));
    expect(await screen.findByText('discover.queue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start 1 queued' }));
    expect(await screen.findByText('discover.drain')).toBeInTheDocument();
    fireEvent.click(within(row('A')).getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText('discover.skip')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skipped' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unskip' }));
    expect(await screen.findByText('discover.unskip')).toBeInTheDocument();

    // queued fine but the start failed: still reported, per row
    delete state.fail['POST /api/discover/queue'];
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(await within(await waitFor(() => row('A'))).findByRole('button', { name: 'Make clips' }));
    await waitFor(() => expect(calls('POST', '/api/discover/queue/drain').length).toBeGreaterThanOrEqual(2));

    state.fail['GET /api/discover/candidates'] = 'l';
    fireEvent.click(screen.getByRole('button', { name: 'Queued' }));
    expect(await screen.findByText('discover.listCandidates')).toBeInTheDocument();
  });
});

describe('editing suite', () => {
  it('imports a range with the chosen options', async () => {
    state.music = ['lofi.mp3'];
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Options/ }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'lofi.mp3' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Caption style'), { target: { value: 'hormozi' } });
    fireEvent.change(screen.getByLabelText('Background music'), { target: { value: 'lofi.mp3' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: ' 1:00 ' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2:30' } });
    fireEvent.change(screen.getByPlaceholderText('Paste YouTube URL...'), { target: { value: 'https://youtu.be/x' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import & Process' })); });

    expect(calls('POST', '/api/import')[0]!.body).toEqual({ url: 'https://youtu.be/x', startTime: '1:00', endTime: '2:30' });
    expect(calls('POST', '/api/process')[0]!.body).toEqual({ videoId: 'vnew', options: { style: 'hormozi', bgm: 'lofi.mp3' } });
  });

  it('reports a failure to load the editing choices', async () => {
    state.fail['GET /api/options'] = 'old backend';
    await renderLoaded();
    expect(await screen.findByText('loadOptions')).toBeInTheDocument();
  });

  it('edits a clip, re-renders it and busts the cached preview', async () => {
    seedCompleted();
    state.captions.c1 = { edited: false, words: [{ text: 'halo', start: 30.5, end: 31 }] };
    await renderLoaded();
    fireEvent.click(within(card('c1')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit clip' })).toBeInTheDocument();
    fireEvent.change(await screen.findByDisplayValue('halo'), { target: { value: 'Halo' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save & re-render' })); });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit clip' })).not.toBeInTheDocument());
    expect(calls('GET', '/api/videos/v1/clips').length).toBeGreaterThan(1);       // clips refreshed
    expect(within(card('c1')).getByRole('link', { name: 'Download' }))
      .toHaveAttribute('href', '/api/clips/c1/export?v=2026-10-27T12%3A00%3A00.000Z');
    fireEvent.click(within(card('c1')).getByRole('button', { name: 'Preview' }));
    expect(document.querySelector('video')).toHaveAttribute('src', '/api/clips/c1/preview?v=2026-10-27T12%3A00%3A00.000Z');
  });

  it('renders a clip the pipeline left for later', async () => {
    seedCompleted();
    await renderLoaded();
    expect(within(card('c2')).queryByRole('button', { name: 'Render' })).not.toBeInTheDocument();   // already rendered
    expect(within(card('c3')).queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(card('c3')).getByRole('button', { name: 'Render' })); });

    expect(calls('POST', '/api/clips/c3/rerender')[0]!.body).toEqual({});
    await waitFor(() => expect(within(card('c3')).getByRole('button', { name: 'Preview' })).toBeInTheDocument());
    expect(within(card('c3')).queryByRole('button', { name: 'Render' })).not.toBeInTheDocument();
    expect(within(card('c3')).getByRole('link', { name: 'Download' }))
      .toHaveAttribute('href', '/api/clips/c3/export?v=2026-10-27T12%3A00%3A00.000Z');
  });

  it('a failed render can be retried', async () => {
    seedCompleted();
    state.clips.v1![2] = { ...state.clips.v1![2]!, renderStatus: 'FAILED' };
    state.fail['POST /api/clips/c3/rerender'] = 'ffmpeg died';
    await renderLoaded();
    await act(async () => { fireEvent.click(within(card('c3')).getByRole('button', { name: 'Retry render' })); });
    expect(await screen.findByText('renderClip')).toBeInTheDocument();
    expect(within(card('c3')).getByRole('button', { name: 'Retry render' })).toBeEnabled();
  });

  it('offers no Render while the video is still processing', async () => {
    jest.useFakeTimers();
    seedCompleted();
    state.jobs = [makeJob('j1', 'v1', 'RUNNING', { currentStage: 'RENDER' })];
    state.stages.j1 = makeStages('j1', 5, 'RENDER');
    await renderLoaded();
    expect(within(card('c3')).queryByRole('button', { name: 'Render' })).not.toBeInTheDocument();
  });

  it('shows a clip being rendered elsewhere as busy', async () => {
    seedCompleted();
    state.clips.v1![2] = { ...state.clips.v1![2]!, renderStatus: 'RENDERING' };
    await renderLoaded();
    expect(within(card('c3')).getByRole('button', { name: 'Rendering...' })).toBeDisabled();
  });

  it('closing the editor changes nothing', async () => {
    seedCompleted();
    await renderLoaded();
    fireEvent.click(within(card('c2')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Edit clip' })).not.toBeInTheDocument();
    expect(calls('POST', '/api/clips/c2/rerender')).toHaveLength(0);
  });
});

describe('LLM, gate and publishing on clip cards; the Settings app', () => {
  it('shows the gate verdict, an LLM or Jev pick and the reason; Publish only with Tebar connected', async () => {
    seedCompleted();
    state.clips.v1 = [
      makeClip('c1', 'v1', 'PRIMARY', 1, { source: 'llm', reason: 'LLM pick: setup and payoff', gateVerdict: 'PASS',
        gate: JSON.stringify({ verdict: 'PASS', by: 'jev', model: 'jev-1.14.0', reasons: [], answers: {}, quality: 0.9 }) }),
      makeClip('c2', 'v1', 'BACKUP', 2, { gateVerdict: 'FAIL', reason: 'Held back: needs earlier context to make sense.',
        gate: JSON.stringify({ verdict: 'FAIL', by: 'rules', model: null, reasons: ['needs earlier context to make sense'], answers: {}, quality: 0.3 }) }),
      makeClip('c3', 'v1', 'BACKUP', 3, { gateVerdict: 'REVIEW', gate: '{broken' }),
      makeClip('c4', 'v1', 'BACKUP', 4, { source: 'jev', reason: 'Jev: strong opening, clear payoff' }),
      makeClip('c5', 'v1', 'BACKUP', 5, { source: 'rules' }),
    ];
    await renderLoaded();
    const c1 = card('c1');
    expect(within(c1).getByText('Gate PASS')).toHaveAttribute('title', 'Jev (jev-1.14.0)');
    expect(within(c1).getByText('LLM pick')).toBeInTheDocument();
    expect(within(c1).getByText('LLM pick: setup and payoff')).toBeInTheDocument();
    expect(within(card('c2')).getByText('Gate FAIL · rules')).toHaveAttribute('title', 'Rules: needs earlier context to make sense');
    expect(within(card('c3')).getByText('Gate REVIEW')).toHaveAttribute('title', 'Rules');
    expect(within(card('c4')).getByText('Jev pick')).toHaveAttribute('title', 'Moment picked by the Jev director');
    expect(within(card('c5')).queryByText(/ pick$/)).not.toBeInTheDocument();
    expect(within(c1).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('connecting Tebar in Settings turns on Publish, which opens the publish window', async () => {
    seedCompleted();
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const tebar = await screen.findByRole('region', { name: 'Tebar publishing' });
    fireEvent.change(within(tebar).getByLabelText('Tebar publishing API key'), { target: { value: 'tb_live_abcd1234' } });
    fireEvent.click(within(tebar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(tebar).getByText('active')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /import & clips/i }));
    fireEvent.click(await waitFor(() => within(card('c1')).getByRole('button', { name: 'Publish' })));
    expect(await screen.findByRole('dialog', { name: 'Publish clip' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Publish clip' })).not.toBeInTheDocument();
  });

  it('a connected Tebar from the start shows Publish; settings load failures are reported', async () => {
    seedCompleted();
    state.settings = makeConnections({ tebar: { ...makeConnections().tebar, active: true, apiKeySet: true, apiKey: '••••1234' } });
    const first = await renderLoaded();
    expect(await waitFor(() => within(card('c1')).getByRole('button', { name: 'Publish' }))).toBeInTheDocument();
    expect(within(card('c3')).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();   // not rendered yet
    first.unmount();
    state.fail['GET /api/settings'] = 'db locked';
    await renderLoaded();
    expect(await screen.findByText(/db locked/)).toBeInTheDocument();
  });
});
