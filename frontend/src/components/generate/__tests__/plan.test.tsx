import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { assetKind, BriefForm } from '../BriefForm';
import { DirectorLog } from '../DirectorLog';
import { GenerateWindow } from '../GenerateWindow';
import { PlanEditor } from '../PlanEditor';
import { StorylineCards } from '../StorylineCards';
import {
  emptyState, installFakeApi, makeGenPlan, makeGenProject, makePlanRow, makeStoryline, type FakeState,
} from '../../../../test/fakeApi';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  window.confirm = jest.fn(() => true);
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

const api = new ApiClient('');
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

describe('BriefForm', () => {
  it('needs a brief of at most 2,000 characters and a length of 5 to 90 s; sends only what was filled in', () => {
    const onCreate = jest.fn();
    render(<BriefForm busy={false} onCreate={onCreate} />);
    const go = screen.getByRole('button', { name: 'Plan my video' });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: '  Jelaskan bunga majemuk ' } });
    expect(screen.getByText('25 / 2000')).toBeInTheDocument();
    expect(go).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '3' } });
    expect(go).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('5 to 90 seconds');
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: '16:9' } });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } });
    fireEvent.click(go);
    expect(onCreate).toHaveBeenCalledWith({ brief: 'Jelaskan bunga majemuk', format: '16:9', targetSec: 45, language: 'en' }, []);
    expect(screen.queryByLabelText('Recipe')).not.toBeInTheDocument();
  });

  it('sends style notes and files with their kind; refuses a file Generate can not use; offers a recipe when there are several', () => {
    const onCreate = jest.fn();
    render(<BriefForm busy={false} onCreate={onCreate} recipes={[{ id: 'quick', name: 'Quick' }, { id: 'story', name: 'Story' }]} />);
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Style notes'), { target: { value: ' tenang ' } });
    fireEvent.change(screen.getByLabelText('Recipe'), { target: { value: 'story' } });
    const logo = new File(['l'], 'logo.png');
    fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [logo] } });
    const bad = new File(['b'], 'virus.exe');
    fireEvent.change(screen.getByLabelText('More files'), { target: { files: [bad] } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan my video' }));
    expect(screen.getByRole('alert')).toHaveTextContent('virus.exe');
    expect(onCreate).not.toHaveBeenCalled();

    const font = new File(['f'], 'Mine.ttf');
    const song = new File(['s'], 'lagu.MP3');
    fireEvent.change(screen.getByLabelText('More files'), { target: { files: [font, song] } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan my video' }));
    expect(onCreate).toHaveBeenCalledWith(
      { brief: 'x', format: '9:16', targetSec: 30, language: 'id', styleNotes: 'tenang', recipeId: 'story' },
      [{ file: logo, kind: 'logo' }, { file: font, kind: 'font' }, { file: song, kind: 'music' }],
    );
  });

  it('is disabled while busy, and file kinds follow the extension', () => {
    render(<BriefForm busy onCreate={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect([assetKind('a.PNG'), assetKind('a.woff2'), assetKind('a.m4a'), assetKind('a.exe'), assetKind('noext')]).toEqual(['image', 'font', 'music', null, null]);
  });
});

describe('StorylineCards', () => {
  const list = [makeStoryline(1), makeStoryline(2, { bold: true, reason: '' }), makeStoryline(3)];

  it('shows each film with its badges; picking sends the number and the note', () => {
    const onPick = jest.fn();
    const onMore = jest.fn();
    render(<StorylineCards storylines={list} picked={2} busy={false} onPick={onPick} onMore={onMore} />);
    const first = screen.getByRole('article', { name: 'Storyline 1: Film 1' });
    expect(within(first).getByText('recommended')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Storyline 2: Film 2' })).getByText('bold')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Storyline 3: Film 3' })).getByText('picked')).toBeInTheDocument();
    expect(within(first).getByText('hook → isi → akhir', { exact: false })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note for the director'), { target: { value: 'lebih tenang' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use storyline 2' }));
    expect(onPick).toHaveBeenCalledWith(1, 'lebih tenang');
    fireEvent.click(screen.getByRole('button', { name: 'Show me different ones' }));
    expect(onMore).toHaveBeenCalledWith('lebih tenang');
  });

  it('can not be used while busy', () => {
    render(<StorylineCards storylines={list} picked={null} busy onPick={jest.fn()} onMore={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Use storyline 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show me different ones' })).toBeDisabled();
  });
});

describe('PlanEditor', () => {
  const rows = (over: Parameters<typeof makePlanRow>[3] = {}) => [makePlanRow('pl1', 1, makeGenPlan(), over)];
  const editor = (plans = rows(), extra: Partial<React.ComponentProps<typeof PlanEditor>> = {}) => {
    const props = { plans, targetSec: 30, busy: false, onSave: jest.fn(), onRevise: jest.fn(), onApprove: jest.fn(), ...extra } as React.ComponentProps<typeof PlanEditor> & { onSave: jest.Mock; onRevise: jest.Mock; onApprove: jest.Mock };
    return { props, ...render(<PlanEditor {...props} />) };
  };

  it('edits shots, shows the running total, saves the edit and only then lets the owner approve', () => {
    const { props } = editor();
    expect(screen.getByText('Plan, revision 1')).toBeInTheDocument();
    expect(screen.getByText('needs your approval')).toBeInTheDocument();
    expect(screen.getByText('30 s of 30 s')).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve this plan' });
    expect(screen.getByRole('button', { name: 'Save my edits' })).toBeDisabled();
    expect(approve).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Shot 2 title'), { target: { value: 'Judul baru' } });
    fireEvent.change(screen.getByLabelText('Shot 2 visual'), { target: { value: 'Benih tumbuh' } });
    fireEvent.change(screen.getByLabelText('Shot 2 motion'), { target: { value: 'zoom' } });
    fireEvent.change(screen.getByLabelText('Plan title'), { target: { value: 'Judul plan' } });
    fireEvent.change(screen.getByLabelText('Plan message'), { target: { value: 'Pesan' } });
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask the director' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Shot 3 seconds'), { target: { value: '16' } });
    expect(screen.getByText('36 s of 30 s')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('30 s, give or take 10%');
    fireEvent.click(screen.getByRole('button', { name: 'Save my edits' }));
    const saved = props.onSave.mock.calls[0][0];
    expect(saved).toMatchObject({ title: 'Judul plan', message: 'Pesan' });
    expect(saved.shots[1]).toMatchObject({ text: [{ role: 'title', value: 'Judul baru' }], visual: { description: 'Benih tumbuh' }, motion: 'zoom' });
    expect(saved.shots[2].durationSec).toBe(16);
  });

  it('approving sends the current revision; asking the director sends the words and clears the box', () => {
    const { props } = editor(rows(), {});
    fireEvent.change(screen.getByLabelText('Ask the director'), { target: { value: '  buat shot 2 lebih singkat ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask the director' })[0]!);
    expect(props.onRevise).toHaveBeenCalledWith('buat shot 2 lebih singkat');
    expect(screen.getByLabelText('Ask the director')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Approve this plan' }));
    expect(props.onApprove).toHaveBeenCalledWith('pl1');
  });

  it('a new revision replaces what is on screen; the history lists each request and summary', () => {
    const second = makePlanRow('pl2', 2, makeGenPlan({ title: 'Revisi dua' }), { changeRequest: 'ubah judul', changeSummary: 'Judul diganti' });
    const { rerender, props } = editor(rows());
    fireEvent.change(screen.getByLabelText('Plan title'), { target: { value: 'Setengah diedit' } });
    rerender(<PlanEditor {...props} plans={[second, ...rows()]} />);
    expect(screen.getByLabelText('Plan title')).toHaveValue('Revisi dua');
    expect(screen.getByText('Plan, revision 2')).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Revisions' });
    expect(history).toHaveTextContent('Revision 2');
    expect(history).toHaveTextContent('you asked: “ubah judul”');
    expect(history).toHaveTextContent('Judul diganti');
  });

  it('an approved plan is read-only and shows the director\'s assumptions', () => {
    editor([makePlanRow('pl1', 1, makeGenPlan({ assumptions: ['Angka 5 ditambah'] }), { approvedAt: '2026-01-01' })]);
    expect(screen.getByText('approved')).toBeInTheDocument();
    expect(screen.getByLabelText('Plan title')).toBeDisabled();
    expect(screen.getByLabelText('Shot 1 seconds')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve this plan' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ask the director')).not.toBeInTheDocument();
    expect(screen.getByText('Angka 5 ditambah')).toBeInTheDocument();
  });
});

describe('DirectorLog', () => {
  beforeEach(() => { state.genProjects = [{ project: makeGenProject('g1'), plans: [], versions: [], assets: [], exports: [] }]; });

  it('loads the log when opened, with each call and its text', async () => {
    state.genNext.events = [
      { id: 'e1', kind: 'plan', model: 'qwen', request: 'the brief', response: '{"title":1}', ok: 1, ms: 2500, createdAt: 't' },
      { id: 'e2', kind: 'storylines', model: null, request: null, response: null, ok: 0, ms: null, createdAt: 't' },
    ];
    render(<DirectorLog api={api} projectId="g1" version="v1" />);
    expect(screen.queryByLabelText('Director log')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show director log' }));
    expect(await screen.findByText('2.5 s', { exact: false })).toHaveTextContent('plan · ok · 2.5 s · qwen');
    expect(screen.getByText('the brief')).toBeInTheDocument();
    expect(screen.getByText('storylines').closest('summary')).toHaveTextContent('storylines · failed');
    fireEvent.click(screen.getByRole('button', { name: 'Hide director log' }));
    expect(screen.queryByLabelText('Director log')).not.toBeInTheDocument();
  });

  it('says so when there is nothing yet, and when the log can not be read', async () => {
    const { unmount } = render(<DirectorLog api={api} projectId="g1" version="v1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show director log' }));
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
    unmount();
    state.fail['GET /api/generate/projects/g1/events'] = 'log unavailable';
    render(<DirectorLog api={api} projectId="g1" version="v1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show director log' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('log unavailable');
  });
});

describe('GenerateWindow: brief to approved plan', () => {
  const open = async () => {
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByTestId('generate-ready');
  };

  it('starts on a new video; creating one uploads its files and shows the storylines', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'Jelaskan bunga majemuk' } });
    fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [new File(['l'], 'logo.png')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan my video' }));
    expect(await screen.findByRole('article', { name: 'Storyline 1: Film 1' })).toBeInTheDocument();
    expect(sent('POST', '/api/generate/projects')[0]).toMatchObject({ brief: 'Jelaskan bunga majemuk', targetSec: 30 });
    expect(sent('POST', '/api/generate/projects/g1/assets')[0]).toEqual({ fileName: 'logo.png', kind: 'logo' });
    expect(await screen.findByText('logo: logo.png')).toBeInTheDocument();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('g1');
  });

  it('pick, edit, ask the director, approve', async () => {
    state.genProjects = [{ project: makeGenProject('g1', { storylines: state.genNext.storylines }), plans: [], versions: [], assets: [], exports: [] }];
    await open();
    fireEvent.change(await screen.findByLabelText('Note for the director'), { target: { value: 'lebih tenang' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use storyline 2' }));
    expect(await screen.findByText('Plan, revision 1')).toBeInTheDocument();
    expect(sent('POST', '/api/generate/projects/g1/storylines/1/pick')[0]).toEqual({ note: 'lebih tenang' });

    fireEvent.change(screen.getByLabelText('Shot 1 title'), { target: { value: 'Judul tangan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save my edits' }));
    expect(await screen.findByText('Plan, revision 2')).toBeInTheDocument();
    expect((sent('PUT', '/api/generate/projects/g1/plan')[0] as any).plan.shots[0].text[0].value).toBe('Judul tangan');

    fireEvent.change(screen.getByLabelText('Ask the director'), { target: { value: 'ganti judul' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask the director' })[0]!);
    expect(await screen.findByText('Plan, revision 3')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Revisions' })).toHaveTextContent('Diubah');

    fireEvent.click(screen.getByRole('button', { name: 'Approve this plan' }));
    expect(await screen.findByText(/Plan approved\. It is locked/)).toBeInTheDocument();
    expect(sent('POST', '/api/generate/projects/g1/plan/approve')[0]).toEqual({ planId: 'pl3' });
  });

  it('"show me different ones" asks for new storylines with the note', async () => {
    state.genProjects = [{ project: makeGenProject('g1', { storylines: [makeStoryline(1)] }), plans: [], versions: [], assets: [], exports: [] }];
    await open();
    fireEvent.change(await screen.findByLabelText('Note for the director'), { target: { value: 'lebih berani' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show me different ones' }));
    await waitFor(() => expect(screen.getByRole('article', { name: 'Storyline 3: Film 3' })).toBeInTheDocument());
    expect(sent('POST', '/api/generate/projects/g1/storylines')[0]).toEqual({ note: 'lebih berani' });
  });

  it('follows a project while the director works, then shows its result', async () => {
    const detail = { project: makeGenProject('g1', { status: 'RUNNING' }), plans: [], versions: [], assets: [], exports: [] };
    state.genProjects = [detail];
    await open();
    expect(await screen.findByRole('status')).toHaveTextContent('Writing storylines…');
    act(() => { detail.project.status = 'WAITING'; detail.project.storylines = state.genNext.storylines; });
    expect(await screen.findByRole('article', { name: 'Storyline 1: Film 1' })).toBeInTheDocument();
    expect(screen.queryByText('Writing storylines…')).not.toBeInTheDocument();
  });

  it('says what the director is doing after a pick', async () => {
    state.genProjects = [{ project: makeGenProject('g1', { status: 'RUNNING', storylines: state.genNext.storylines, pickedStoryline: 0 }), plans: [], versions: [], assets: [], exports: [] }];
    await open();
    expect(await screen.findByRole('status')).toHaveTextContent('Writing the plan from your pick…');
  });

  it('a failed project shows what went wrong and retry picks it up again', async () => {
    state.genProjects = [{ project: makeGenProject('g1', { status: 'FAILED', errorMessage: 'quota exceeded', storylines: [makeStoryline(1)] }), plans: [], versions: [], assets: [], exports: [] }];
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('That didn’t work: quota exceeded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/quota exceeded/)).not.toBeInTheDocument());
    expect(sent('POST', '/api/generate/projects/g1/retry')).toHaveLength(1);
  });

  it('shows errors from the API instead of failing silently; files can be removed; a video can be deleted', async () => {
    const detail = {
      project: makeGenProject('g1', { title: 'Judul', storylines: [makeStoryline(1)] }), plans: [], versions: [], exports: [],
      assets: [{ id: 'a1', projectId: 'g1', kind: 'logo', origin: 'upload', path: 'assets/12345678-logo.png', shotId: null, createdAt: 't' }],
    };
    state.genProjects = [detail];
    await open();
    expect(await screen.findByText('logo: logo.png')).toBeInTheDocument();
    state.fail['POST /api/generate/projects/g1/storylines/0/pick'] = 'The project is still working';
    fireEvent.click(screen.getByRole('button', { name: 'Use storyline 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The project is still working');

    fireEvent.click(screen.getByRole('button', { name: 'Remove assets/12345678-logo.png' }));
    await waitFor(() => expect(screen.queryByText('logo: logo.png')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete this video' }));
    await waitFor(() => expect(screen.getByLabelText('Brief')).toBeInTheDocument());
    expect(state.genProjects).toHaveLength(0);
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('new');
  });

  it('a declined confirmation keeps the video; the project list names untitled videos by their brief', async () => {
    (window.confirm as jest.Mock).mockReturnValue(false);
    const long = 'Jelaskan bunga majemuk untuk anak muda yang baru mulai menabung';
    state.genProjects = [{ project: makeGenProject('g1', { brief: long }), plans: [], versions: [], assets: [], exports: [] }];
    await open();
    await screen.findByText(long);
    expect(screen.getByRole('option', { name: `${long.slice(0, 40)}…` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete this video' }));
    expect(state.genProjects).toHaveLength(1);
  });

  it('reports a project that can not be loaded, or a list that can not be read', async () => {
    state.genProjects = [{ project: makeGenProject('g1'), plans: [], versions: [], assets: [], exports: [] }];
    state.fail['GET /api/generate/projects/g1'] = 'gone';
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('gone');
  });

  it('shows the error when the project list can not be read', async () => {
    state.fail['GET /api/generate/projects'] = 'list failed';
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('list failed');
  });
});
