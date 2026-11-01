import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { ConnectionsPanel } from '../ConnectionsPanel';
import { GeneratedLibrary } from '../GeneratedLibrary';
import { PublishPanel, SAVED_ACCOUNTS, scheduleIso } from '../PublishPanel';
import { emptyState, installFakeApi, makeAccount, makeClip, makeGenExport, makeGenProject, makePost, type FakeState } from '../../../test/fakeApi';
import type { DraftTarget } from '@/types';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
});

const api = new ApiClient('');
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
const region = (name: string) => screen.getByRole('region', { name });

describe('ConnectionsPanel', () => {
  it('shows the three connections, saves only changed fields and never shows a key back', async () => {
    render(<ConnectionsPanel api={api} />);
    expect(screen.getByText('Loading settings…')).toBeInTheDocument();
    const llm = await screen.findByRole('region', { name: 'LLM' });
    expect(within(llm).getByText('off')).toBeInTheDocument();
    expect(within(llm).getByText(/the rules find, score and title the clips/)).toBeInTheDocument();
    expect(within(region('Tebar publishing')).queryByLabelText(/Director/)).not.toBeInTheDocument();

    const save = within(llm).getByRole('button', { name: 'Save' });
    const key = within(llm).getByLabelText('LLM API key');
    expect(save).toBeDisabled();
    fireEvent.change(within(llm).getByLabelText('LLM Base URL'), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(within(llm).getByLabelText('LLM Model'), { target: { value: 'qwen2.5:7b' } });
    fireEvent.change(key, { target: { value: ' sk-1234abcd ' } });
    fireEvent.click(save);
    await waitFor(() => expect(within(llm).getByText('active')).toBeInTheDocument());
    expect(sent('PUT', '/api/settings/llm')[0]).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', apiKey: 'sk-1234abcd' });
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', '••••abcd (leave empty to keep)');

    fireEvent.click(within(llm).getByRole('button', { name: 'Use .env' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/llm')[1]).toEqual({ baseUrl: null, model: null, apiKey: null }));
    const jevDirector = within(region('Jev quality gate')).getByLabelText(/wins over the LLM director/);
    fireEvent.click(jevDirector);
    await waitFor(() => expect(jevDirector).not.toBeChecked());
    expect(sent('PUT', '/api/settings/jev')).toEqual([{ director: false }]);
  });

  it('tests a connection and shows the result; errors are shown', async () => {
    state.tests.jev = { ok: true, ms: 87, model: 'jev-1.14.0', detail: 'answered 0.97' };
    state.fail['POST /api/settings/llm/test'] = 'backend down';
    render(<ConnectionsPanel api={api} />);
    await screen.findByRole('region', { name: 'LLM' });
    for (const [name, result] of [['Jev quality gate', 'OK in 87 ms · jev-1.14.0 · answered 0.97'],
      ['Tebar publishing', 'Failed: Not configured'], ['LLM', 'Failed: backend down']] as const) {
      fireEvent.click(within(region(name)).getByRole('button', { name: 'Test' }));
      expect(await within(region(name)).findByText(result)).toBeInTheDocument();
    }
    state.fail['PUT /api/settings/tebar'] = 'apiKey must not contain spaces';
    fireEvent.click(within(region('Tebar publishing')).getByLabelText(/Use Tebar publishing/));
    expect(await within(region('Tebar publishing')).findByRole('alert')).toHaveTextContent('apiKey must not contain spaces');
  });
});

const ACCOUNTS = [makeAccount('tt', 'tiktok', 'budi.tt'), makeAccount('yt', 'youtube', 'Kanal'), makeAccount('ig', 'instagram', 'budi.ig')];
const target = (id: string, extra: Partial<DraftTarget> = {}): DraftTarget => {
  const { platform, name } = ACCOUNTS.find((a) => a.id === id)!;
  return { accountId: id, platform, name, content: `copy for ${platform}`, copyBy: 'llm', needs: {}, warnings: [], blockers: [], ...extra };
};

describe('PublishPanel', () => {
  const clip = makeClip('c1', 'v1', 'PRIMARY', 1);
  const open = (onClose = () => {}) => render(<PublishPanel clip={clip} api={api} onClose={onClose} />);
  /** Ticks (or unticks) these accounts, then asks for copy. */
  const writeCopy = async (...accounts: string[]) => {
    for (const name of accounts) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(name) }));
    fireEvent.click(screen.getByRole('button', { name: /write copy/i }));
  };
  const publishNow = () => screen.getByRole('button', { name: 'Publish now' });
  const posted = () => sent('POST', '/api/clips/c1/publish');
  const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  /** Each account checkbox: on, off or disabled. */
  const boxes = () => screen.getAllByRole('checkbox').map((b) => ((b as HTMLInputElement).disabled ? 'disabled' : (b as HTMLInputElement).checked ? 'on' : 'off'));

  beforeEach(() => {
    localStorage.clear();
    state.accounts = ACCOUNTS;
    state.draft = { clip: { id: 'c1', title: 'Judul', gateVerdict: 'PASS', gateReasons: [] }, copyCheckedBy: 'jev-1.14.0', targets: [
      target('tt', { needs: { tiktokPrivacy: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, warnings: ['Jev: this copy may claim more than the clip says — check it'] }),
      target('yt', { title: 'Judul YT', content: 'Desk #shorts', copyBy: 'template', needs: { madeForKids: true } }),
      target('ig', { blockers: ['instagram needs videos of at least 3 s'] })] };
  });
  afterEach(() => jest.restoreAllMocks());

  it('drafts copy; platform blockers and the user-only choices hold publishing; schedules the edited copy', async () => {
    const closed = jest.fn();
    open(closed);
    expect(await screen.findByRole('button', { name: 'Write copy' })).toBeDisabled();   // no account ticked yet
    expect(screen.getByRole('group')).not.toHaveAccessibleName();                       // one workspace: no headings
    await writeCopy('budi.ig');
    expect(await screen.findByText(/instagram needs videos of at least 3 s/)).toBeInTheDocument();
    expect(publishNow()).toBeDisabled();
    await writeCopy('budi.ig', 'budi.tt', 'Kanal');                                     // swap Instagram for TikTok + YouTube
    expect(await screen.findByLabelText('Title for Kanal')).toHaveValue('Judul YT');
    expect(sent('POST', '/api/clips/c1/publish/draft')).toEqual([{ accountIds: ['ig'] }, { accountIds: ['tt', 'yt'] }]);
    expect(screen.getByText('Copy checked by jev-1.14.0.')).toBeInTheDocument();
    expect(screen.getByText(/may claim more than the clip says/)).toBeInTheDocument();

    expect(screen.getByLabelText('Privacy for budi.tt')).toHaveValue('');              // TikTok privacy is never pre-chosen
    edit('Privacy for budi.tt', 'SELF_ONLY');
    expect(publishNow()).toBeDisabled();                                                // nor is made-for-kids
    fireEvent.click(screen.getAllByLabelText('No')[0]!);
    edit('Text for budi.tt', 'Teks baru #fyp');
    expect(screen.getByText('Text (14 characters)')).toBeInTheDocument();
    edit('Title for Kanal', '');
    expect(publishNow()).toBeDisabled();                                                // YouTube needs a title
    edit('Title for Kanal', 'Judul final');
    edit('Schedule', '2030-01-02T19:30');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(posted()).toEqual([{ scheduledAt: new Date('2030-01-02T19:30').toISOString(), targets: [
      { accountId: 'tt', content: 'Teks baru #fyp', privacyLevel: 'SELF_ONLY', postMode: 'direct' },
      { accountId: 'yt', content: 'Desk #shorts', title: 'Judul final', madeForKids: false }] }]));
    expect(await screen.findByText('Posts of this clip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(scheduleIso('')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toHaveBeenCalled();
  });

  it('a TikTok post goes direct by default (privacy needed) or as a draft to the TikTok app (no privacy sent)', async () => {
    state.draft!.targets = [state.draft!.targets[0]!];
    open();
    await writeCopy('budi.tt');
    expect(await screen.findByLabelText('Post directly')).toBeChecked();
    edit('Privacy for budi.tt', 'SELF_ONLY');
    fireEvent.click(screen.getByLabelText('Send as a draft to the TikTok app'));
    expect(screen.queryByLabelText('Privacy for budi.tt')).not.toBeInTheDocument();
    expect(screen.getByText(/finish it and choose who can see it there/)).toBeInTheDocument();
    fireEvent.click(publishNow());
    await waitFor(() => expect(posted()).toEqual([{ targets: [{ accountId: 'tt', content: 'copy for tiktok', postMode: 'draft' }] }]));
  });

  it('groups accounts by workspace: one workspace per post, unsupported accounts disabled, select all', async () => {
    state.accounts = [makeAccount('tt', 'tiktok', 'budi.tt', ['w1', 'Toko']), makeAccount('pin', 'pinterest', 'Pins', ['w1', 'Toko'], { supported: false }),
      makeAccount('yt', 'youtube', 'Kanal', ['w1', 'Toko']), makeAccount('ig', 'instagram', 'pribadi.ig', ['w2', 'Pribadi'])];
    localStorage.setItem(SAVED_ACCOUNTS, JSON.stringify(['ig', 'tt']));                // spans workspaces: the first one's kept
    open();
    const toko = await screen.findByRole('group', { name: 'Toko' });
    expect(boxes()).toEqual(['on', 'disabled', 'off', 'disabled']);
    expect(within(toko).getByText(/can't post a video here/)).toBeInTheDocument();
    expect(screen.getByText('A post goes to one workspace at a time.')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Pribadi' })).getByRole('button', { name: 'Select all' })).toBeDisabled();
    fireEvent.click(within(toko).getByRole('button', { name: 'Select all' }));
    expect(boxes()).toEqual(['on', 'disabled', 'on', 'disabled']);
    fireEvent.click(screen.getByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Kanal/ }));
    expect(boxes()).toEqual(['off', 'disabled', 'off', 'off']);                          // nothing picked: every workspace is open
    expect(screen.queryByText('A post goes to one workspace at a time.')).not.toBeInTheDocument();
  });

  it('remembers the picked accounts and pre-selects those still listed; works without storage', async () => {
    localStorage.setItem(SAVED_ACCOUNTS, JSON.stringify(['yt', 'gone']));
    const { unmount } = open();
    await screen.findByRole('checkbox', { name: /Kanal/ });
    expect(boxes()).toEqual(['off', 'on', 'off']);
    fireEvent.click(screen.getByRole('checkbox', { name: /budi.tt/ }));
    expect(JSON.parse(localStorage.getItem(SAVED_ACCOUNTS)!)).toEqual(['yt', 'tt']);
    unmount();
    for (const m of ['getItem', 'setItem'] as const) jest.spyOn(Storage.prototype, m).mockImplementation(() => { throw new Error('denied'); });
    open();
    fireEvent.click(await screen.findByRole('checkbox', { name: /budi.tt/ }));
    expect(boxes()).toEqual(['on', 'off', 'off']);
  });

  it.each([
    ['REVIEW', ['may accuse a real person or company of wrongdoing'], [], /I checked it.*may accuse a real person/, { confirmReview: true }],
    ['FAIL', [], ['Held back by the quality gate: mostly filler'], /Post anyway.*no reason given/, { override: true }],
  ])('a gate %s must be confirmed, with its reasons shown, before publishing', async (gateVerdict, gateReasons, blockers, confirm, flag) => {
    state.draft = { ...state.draft!, clip: { id: 'c1', title: 'J', gateVerdict, gateReasons }, targets: [target('tt', { blockers })] };
    open();
    await writeCopy('budi.tt');
    const box = await screen.findByLabelText(confirm);
    expect(publishNow()).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(publishNow());
    await waitFor(() => expect(posted()).toEqual([{ targets: [{ accountId: 'tt', content: 'copy for tiktok', postMode: 'direct' }], ...flag }]));
  });

  it('lists earlier posts: refresh, retry failed or partial ones, cancel scheduled ones; no accounts is explained', async () => {
    state.posts.c1 = [makePost('p1', 'c1', { status: 'SCHEDULED', scheduledAt: '2030-01-01T00:00:00Z' }),
      makePost('p2', 'c1', { status: 'FAILED', errorMessage: 'tiktok: account_expired' }), makePost('p3', 'c1', { status: 'PARTIAL', targets: '{bad' })];
    state.accounts = [];
    open();
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    expect(await screen.findByText('tiktok: account_expired')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    const buttons = () => rows.map((r) => within(r).getAllByRole('button').map((b) => b.textContent).join(' '));
    expect(buttons()).toEqual(['Cancel Refresh', 'Retry Refresh', 'Retry Refresh']);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Cancel' }));
    expect(await within(rows[0]!).findByText(/^CANCELLED/)).toBeInTheDocument();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('tiktok: account_expired')).not.toBeInTheDocument());
    expect(buttons()).toEqual(['Refresh', 'Refresh', 'Retry Refresh']);
    fireEvent.click(within(rows[2]!).getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('link', { name: 'open' })).toHaveAttribute('href', 'https://tiktok.com/@x/video/1');
  });

  it.each([
    ['GET /api/social/accounts', 'Tebar is not connected', async () => {}],
    ['POST /api/clips/c1/publish/draft', 'Pick at least one account', () => writeCopy('budi.tt')],
    ['POST /api/social/posts/p1/cancel', 'Tebar: the post is already out', async () => fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))],
  ])('shows the error when %s fails', async (route, error, act) => {
    state.posts.c1 = [makePost('p1', 'c1', { status: 'SCHEDULED' })];
    state.fail[route] = error;
    open();
    await act();
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
  });
});

describe('GeneratedLibrary', () => {
  const seed = () => {
    state.accounts = [makeAccount('tt', 'tiktok', 'budi.tt')];
    state.draft = { clip: { id: 'ex1', title: 'Bunga berbunga', gateVerdict: 'PASS', gateReasons: [] }, copyCheckedBy: null, targets: [
      { accountId: 'tt', platform: 'tiktok', name: 'budi.tt', content: 'Bunga berbunga', copyBy: 'template', needs: {}, warnings: [], blockers: [] }] };
    state.genProjects = [{ project: makeGenProject('g1', { title: 'Bunga majemuk' }), plans: [], versions: [], assets: [], exports: [makeGenExport('ex1')] }];
  };

  it('lists the finished videos; they play, download and publish through the same panel as a clip', async () => {
    seed();
    render(<GeneratedLibrary api={api} />);
    expect(await screen.findByText('Generated (1)')).toBeInTheDocument();
    expect(screen.getByText('Bunga majemuk · 9:16 · 30 s')).toBeInTheDocument();
    expect(screen.getByLabelText('Video Bunga berbunga')).toHaveAttribute('src', '/api/generate/exports/ex1/file');
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/generate/exports/ex1/file?download=1');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('dialog', { name: 'Publish video' })).toBeInTheDocument();
    expect(sent('GET', '/api/generate/exports/ex1/posts')).toHaveLength(1);
    fireEvent.click(await screen.findByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('button', { name: /write copy/i }));
    fireEvent.change(await screen.findByLabelText('Text for budi.tt'), { target: { value: 'Teks saya' } });
    fireEvent.click(screen.getByLabelText('Send as a draft to the TikTok app'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await waitFor(() => expect(sent('POST', '/api/generate/exports/ex1/publish')).toEqual([{ targets: [{ accountId: 'tt', content: 'Teks saya', postMode: 'draft' }] }]));
    expect(await screen.findByText('Posts of this video')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows nothing without exports (or when Generate is unreachable)', async () => {
    const { container, rerender } = render(<GeneratedLibrary api={api} />);
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/api/generate/exports')).toBe(true));
    expect(container).toBeEmptyDOMElement();
    state.fail['GET /api/generate/exports'] = 'off';
    rerender(<GeneratedLibrary api={new ApiClient('')} />);
    await waitFor(() => expect(fake.calls.filter((c) => c.path === '/api/generate/exports')).toHaveLength(2));
    expect(container).toBeEmptyDOMElement();
  });
});
