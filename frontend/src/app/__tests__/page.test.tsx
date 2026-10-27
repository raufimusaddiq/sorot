import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home from '@/app/page';
import {
  emptyState, installFakeApi, makeCandidate, makeClip, makeJob, makeScore, makeStages, makeVideo, ts,
  type FakeState,
} from '../../../test/fakeApi';

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
  const utils = render(<Home />);
  await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
  return utils;
}

/** The ClipCard root for a clip (cards are identified by their transcript text). */
const card = (clipId: string) => screen.getByText(`teks ${clipId}`).closest('.overflow-hidden') as HTMLElement;

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
    expect(screen.getByText('Viral Clipper')).toBeInTheDocument();
    expect(screen.getByText(/AI-powered video clip maker/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import & clips/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import & process/i })).toBeDisabled();
    expect(screen.getByText('No videos yet. Import a YouTube URL above to get started.')).toBeInTheDocument();
  });

  it('shows a loading state before data arrives', () => {
    render(<Home />);
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

  it('validates and submits TikTok feedback', async () => {
    await renderLoaded();
    const c1 = card('c1');
    fireEvent.click(within(c1).getByRole('button', { name: 'FB' }));
    const submit = within(c1).getByRole('button', { name: 'Submit feedback' });

    fireEvent.click(submit);
    expect(within(c1).getByText(/Isi tanggal upload TikTok dulu/)).toBeInTheDocument();

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
    expect(calls('POST', '/api/process')[0]!.body).toEqual({ videoId: 'vnew' });
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

describe('learning tab', () => {
  it('shows stats and keeps training disabled below 5 samples', async () => {
    state.weights = { version: 3, trained_on: 0, total_feedback: 4, with_actual_scores: 2 };
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Learning (2)' }));
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('Need 3 more clips with feedback data to enable training')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retrain Weights' })).toBeDisabled();
  });

  it('retrains and refreshes the stats; training failures are logged', async () => {
    state.weights = { version: 3, trained_on: 0, total_feedback: 6, with_actual_scores: 6 };
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Learning (6)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retrain Weights' }));
    expect(await screen.findByText('v4')).toBeInTheDocument();
    expect(calls('POST', '/api/feedback/train')).toHaveLength(1);

    state.fail['POST /api/feedback/train'] = 'not enough data';
    fireEvent.click(screen.getByRole('button', { name: 'Retrain Weights' }));
    await waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'not enough data' })));
    expect(screen.getByRole('button', { name: 'Retrain Weights' })).toBeEnabled();
  });

  it('without weights the tab has no stats and training is disabled', async () => {
    state.fail['GET /api/feedback/weights'] = 'no model';
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Learning' }));
    expect(screen.queryByText('Total Feedback')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retrain Weights' })).toBeDisabled();
  });
});

describe('discovery panel', () => {
  const openDiscovery = async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
  };
  const row = (title: string) => screen.getByText(title).closest('.rounded-card') as HTMLElement;

  it('shows the empty states per filter', async () => {
    await openDiscovery();
    expect(await screen.findByText('No candidates yet. Run a search above to populate.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'QUEUED' }));
    expect(await screen.findByText('No queued candidates.')).toBeInTheDocument();
    expect(fake.calls.some(c => c.path === '/api/discover/candidates')).toBe(true);
  });

  it('runs search, trending and channel discovery; blank input is ignored', async () => {
    await openDiscovery();
    // [0] is the top-level "Discover" tab; [1] is the panel's submit button.
    const discover = screen.getAllByRole('button', { name: /^Discover$/ })[1]!;

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

  it('shows discovery errors inline', async () => {
    state.fail['POST /api/discover/search'] = 'yt-dlp missing';
    await openDiscovery();
    fireEvent.change(screen.getByPlaceholderText(/Search keywords/), { target: { value: 'x' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Discover$/ })[1]!);
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
    expect(screen.getByRole('button', { name: 'All (3)' })).toBeInTheDocument();

    // select → deselect → select → queue
    const box = within(hot).getByRole('checkbox');
    fireEvent.click(box); fireEvent.click(box); fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 selected' }));
    await waitFor(() => expect(calls('POST', '/api/discover/queue')[0]!.body).toEqual({ ids: ['1'] }));

    // drain everything queued
    fireEvent.click(await screen.findByRole('button', { name: 'Process queue (2)' }));
    await waitFor(() => expect(calls('POST', '/api/discover/queue/drain')).toHaveLength(1));

    // skip the remaining NEW one, then unskip it from the SKIPPED filter
    fireEvent.click(within(row('ytBare')).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(state.candidates.find(c => c.id === '3')!.status).toBe('SKIPPED'));
    fireEvent.click(screen.getByRole('button', { name: 'SKIPPED' }));
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
    expect(within(row('Broke')).getByText('FAILED')).toHaveClass('text-error');
    expect(row('Broke').className).not.toContain('opacity-60');
    expect(within(row('Done')).getByText('IMPORTED')).toHaveClass('text-success');
    expect(row('Done').className).toContain('opacity-60');
    expect(within(row('Nope')).getByText('SKIPPED')).toHaveClass('text-subtle');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(row('Done')).queryByRole('button', { name: /Skip|Unskip/ })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 selected' }));
    expect(await screen.findByText('discover.queue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Process queue (1)' }));
    expect(await screen.findByText('discover.drain')).toBeInTheDocument();
    fireEvent.click(within(row('A')).getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText('discover.skip')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'SKIPPED' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unskip' }));
    expect(await screen.findByText('discover.unskip')).toBeInTheDocument();

    state.fail['GET /api/discover/candidates'] = 'l';
    fireEvent.click(screen.getByRole('button', { name: 'NEW' }));
    expect(await screen.findByText('discover.listCandidates')).toBeInTheDocument();
  });
});
