import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { ConnectionsPanel } from '../ConnectionsPanel';
import { GeneratedLibrary } from '../GeneratedLibrary';
import { PublishPanel, SAVED_ACCOUNTS, scheduleIso } from '../PublishPanel';
import { emptyState, installFakeApi, makeAccount, makeClip, makeConnections, makeGenExport, makeGenProject, makePost, type FakeState } from '../../../test/fakeApi';
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

    fireEvent.click(within(llm).getByRole('button', { name: 'Use a different provider' }));
    const save = within(llm).getByRole('button', { name: 'Save' });
    const key = within(llm).getByLabelText('LLM API key');
    expect(save).toBeDisabled();
    fireEvent.change(within(llm).getByLabelText('LLM Base URL'), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(within(llm).getByLabelText('LLM Model'), { target: { value: 'qwen2.5:7b' } });
    expect(within(llm).getByLabelText('LLM Generate token budget')).toHaveValue('32000');
    fireEvent.change(within(llm).getByLabelText('LLM Generate token budget'), { target: { value: '48000' } });
    fireEvent.change(key, { target: { value: ' sk-1234abcd ' } });
    fireEvent.click(save);
    await waitFor(() => expect(within(llm).getByText('active')).toBeInTheDocument());
    expect(sent('PUT', '/api/settings/llm')[0]).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', genMaxTokens: '48000', apiKey: 'sk-1234abcd' });
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', '••••abcd (leave empty to keep)');

    fireEvent.click(within(llm).getByRole('button', { name: 'Use .env' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/llm')[1]).toEqual({ baseUrl: null, model: null, genMaxTokens: null, apiKey: null }));
    const jevDirector = within(region('Jev quality gate')).getByLabelText(/wins over the LLM director/);
    fireEvent.click(jevDirector);
    await waitFor(() => expect(jevDirector).not.toBeChecked());
    expect(sent('PUT', '/api/settings/jev')).toEqual([{ director: false }]);
  });

  it('tests a connection and shows the result; errors are shown', async () => {
    state.tests.jev = { ok: true, ms: 87, model: 'jev-1.14.0', detail: 'answered 0.97' };
    state.fail['POST /api/settings/llm/test'] = 'backend down';
    render(<ConnectionsPanel api={api} />);
    const llm = await screen.findByRole('region', { name: 'LLM' });
    fireEvent.click(within(llm).getByRole('button', { name: 'Use a different provider' }));
    for (const [name, result] of [['Jev quality gate', 'OK in 87 ms · jev-1.14.0 · answered 0.97'],
      ['Tebar publishing', 'Failed: Not configured'], ['LLM', 'Failed: backend down']] as const) {
      fireEvent.click(within(region(name)).getByRole('button', { name: 'Test' }));
      expect(await within(region(name)).findByText(result)).toBeInTheDocument();
    }
    state.fail['PUT /api/settings/tebar'] = 'apiKey must not contain spaces';
    fireEvent.click(within(region('Tebar publishing')).getByLabelText(/Use Tebar publishing/));
    expect(await within(region('Tebar publishing')).findByRole('alert')).toHaveTextContent('apiKey must not contain spaces');
  });

  it('Kenari: a fresh install offers it first, fetches the live model list, and only saves after the key validates', async () => {
    state.kenariModels = [{ id: 'kenari/auto', free: false }, { id: 'step-3-7-flash:free', free: true }];
    render(<ConnectionsPanel api={api} />);
    const llm = await screen.findByRole('region', { name: 'LLM' });
    fireEvent.click(within(llm).getByRole('button', { name: 'Connect Kenari' }));
    expect(await within(llm).findByRole('option', { name: 'step-3-7-flash:free (free)' })).toBeInTheDocument();
    const save = within(llm).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    const testKey = within(llm).getByRole('button', { name: 'Test key' });
    expect(testKey).toBeDisabled();   // no key typed yet

    fireEvent.change(within(llm).getByLabelText('Kenari API key'), { target: { value: 'kn-bad' } });
    state.kenariProbe = { ok: false, ms: 1, error: 'LLM HTTP 401: invalid key' };
    fireEvent.click(testKey);
    expect(await within(llm).findByText('Failed: LLM HTTP 401: invalid key')).toBeInTheDocument();
    expect(save).toBeDisabled();

    state.kenariProbe = { ok: true, ms: 50, model: 'kenari/auto', detail: 'OK' };
    fireEvent.click(testKey);
    expect(await within(llm).findByText('Key works · kenari/auto')).toBeInTheDocument();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(sent('PUT', '/api/settings/llm')).toEqual([
      { baseUrl: 'https://kenari.id/v1', model: 'kenari/auto', apiKey: 'kn-bad' },
    ]));
  });

  it('Kenari: "Use a different provider" is reachable with no key, and an already-saved custom provider is shown as-is', async () => {
    const first = render(<ConnectionsPanel api={api} />);
    const fresh = await screen.findByRole('region', { name: 'LLM' });
    fireEvent.click(within(fresh).getByRole('button', { name: 'Use a different provider' }));
    expect(within(fresh).queryByLabelText('Kenari API key')).not.toBeInTheDocument();
    expect(within(fresh).getByLabelText('LLM Base URL')).toBeInTheDocument();
    first.unmount();

    state.settings = makeConnections({ llm: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', active: true } });
    render(<ConnectionsPanel api={api} />);
    const existing = await screen.findByRole('region', { name: 'LLM' });
    expect(within(existing).queryByRole('button', { name: 'Connect Kenari' })).not.toBeInTheDocument();
    expect(within(existing).getByLabelText('LLM Base URL')).toHaveValue('http://localhost:11434/v1');
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

describe('GenerateConnections (Settings)', () => {
  const generateSettings = (over: Partial<Record<'voice' | 'image' | 'commands', object>> = {}) => ({
    ...makeConnections(),
    voice: { active: false, enabled: true, saved: [], engine: '', engines: ['elevenlabs', 'fish', 'openai', 'local'], localAvailable: false, voices: {}, baseUrl: '', model: '', apiKey: '', apiKeySet: false, ...over.voice },
    image: { active: false, enabled: true, saved: [], baseUrl: '', model: '', apiKey: '', apiKeySet: false, size: '1024x1024', style: '', ...over.image },
    commands: { active: false, allowed: true, saved: [], commands: [], ...over.commands },
  }) as never;

  it('without the Generate connections the three core cards are all there is', async () => {
    render(<ConnectionsPanel api={api} />);
    await screen.findByRole('region', { name: 'LLM' });
    expect(screen.queryByRole('region', { name: 'Generate connections' })).not.toBeInTheDocument();
  });

  it('the voice: engines (the local one only on a GPU install), a voice per language, a masked key', async () => {
    state.settings = generateSettings();
    render(<ConnectionsPanel api={api} />);
    const voice = await screen.findByRole('region', { name: 'Narration voice' });
    expect(within(voice).getByText(/No engine yet/)).toBeInTheDocument();
    expect(within(voice).getByRole('option', { name: /Local KittenTTS, on this GPU — needs a GPU install/ })).toBeDisabled();
    fireEvent.change(within(voice).getByLabelText('Voice engine'), { target: { value: 'elevenlabs' } });
    await waitFor(() => expect(sent('PUT', '/api/settings/voice')[0]).toEqual({ engine: 'elevenlabs' }));

    const save = within(voice).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(voice).getByLabelText('Voice for Indonesian'), { target: { value: 'voice-id' } });
    fireEvent.change(within(voice).getByLabelText('Voice API key'), { target: { value: ' xi-secret-1234 ' } });
    fireEvent.change(within(voice).getByLabelText('Voice model'), { target: { value: 'eleven_v3' } });
    fireEvent.change(within(voice).getByLabelText('Voice base URL'), { target: { value: 'http://proxy' } });
    fireEvent.click(save);
    await waitFor(() => expect(sent('PUT', '/api/settings/voice')[1]).toEqual({ baseUrl: 'http://proxy', model: 'eleven_v3', voices: { id: 'voice-id' }, apiKey: 'xi-secret-1234' }));
    expect(await within(voice).findByPlaceholderText('••••1234 (leave empty to keep)')).toBeInTheDocument();
    fireEvent.click(within(voice).getByLabelText('Use the voice'));
    await waitFor(() => expect(sent('PUT', '/api/settings/voice')[2]).toEqual({ enabled: false }));
  });

  it('the local engine needs no key and is offered on a GPU install; the server refuses it elsewhere; the voice can be tested', async () => {
    state.settings = generateSettings({ voice: { localAvailable: true, engine: 'local' } });
    state.tests.voice = { ok: true, ms: 40, detail: 'local spoke a test line' };
    const first = render(<ConnectionsPanel api={api} />);
    const voice = await screen.findByRole('region', { name: 'Narration voice' });
    expect(within(voice).getByRole('option', { name: /Local KittenTTS, on this GPU$/ })).toBeEnabled();
    expect(within(voice).getByRole('note')).toHaveTextContent('no Indonesian voice');
    expect(within(voice).queryByLabelText('Voice API key')).not.toBeInTheDocument();
    fireEvent.click(within(voice).getByRole('button', { name: 'Test' }));
    expect(await within(voice).findByText('OK in 40 ms · local spoke a test line')).toBeInTheDocument();
    first.unmount();

    state.settings = generateSettings({ voice: { localAvailable: false } });
    state.fail['PUT /api/settings/voice'] = 'the local voice needs a GPU install';
    render(<ConnectionsPanel api={api} />);
    const again = await screen.findByRole('region', { name: 'Narration voice' });
    fireEvent.change(within(again).getByLabelText('Voice engine'), { target: { value: 'fish' } });
    expect(await within(again).findByRole('alert')).toHaveTextContent('GPU install');
  });

  it('scene images: the service, model and key; it can be switched off and tested', async () => {
    state.settings = generateSettings();
    render(<ConnectionsPanel api={api} />);
    const image = await screen.findByRole('region', { name: 'Scene images' });
    fireEvent.click(within(image).getByRole('button', { name: 'Use a different service' }));
    fireEvent.change(within(image).getByLabelText('Image Base URL'), { target: { value: 'http://img/v1' } });
    fireEvent.change(within(image).getByLabelText('Image Model'), { target: { value: 'flux' } });
    fireEvent.change(within(image).getByLabelText('Image API key'), { target: { value: 'img-key-9999' } });
    fireEvent.click(within(image).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/image')[0]).toEqual({ baseUrl: 'http://img/v1', model: 'flux', apiKey: 'img-key-9999' }));
    fireEvent.click(within(image).getByLabelText('Use images'));
    await waitFor(() => expect(sent('PUT', '/api/settings/image')[1]).toEqual({ enabled: false }));
    fireEvent.click(within(image).getByRole('button', { name: 'Test' }));
    expect(await within(image).findByText('Failed: Not configured')).toBeInTheDocument();
  });

  it('scene images: Kenari offers a fetched model list and saves baseUrl/model together', async () => {
    state.settings = generateSettings();
    state.kenariImageModels = [{ id: 'gpt-image-2', free: false }, { id: 'other-image:free', free: true }];
    render(<ConnectionsPanel api={api} />);
    const image = await screen.findByRole('region', { name: 'Scene images' });
    fireEvent.click(within(image).getByRole('button', { name: 'Connect Kenari' }));
    expect(await within(image).findByRole('option', { name: 'other-image:free (free)' })).toBeInTheDocument();
    fireEvent.change(within(image).getByLabelText('Kenari image model'), { target: { value: 'other-image:free' } });
    fireEvent.change(within(image).getByLabelText('Image API key'), { target: { value: 'kn-good' } });
    fireEvent.click(within(image).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/image')[0]).toEqual({ baseUrl: 'https://kenari.id/v1', model: 'other-image:free', apiKey: 'kn-good' }));
  });

  it('narration voice: Kenari (openai engine only) offers fetched models and per-model voices', async () => {
    state.settings = generateSettings({ voice: { engine: 'openai' } });
    state.kenariVoiceModels = [{ id: 'gemini-3-1-flash-tts', voices: ['Kore', 'Aoede'] }];
    render(<ConnectionsPanel api={api} />);
    const voice = await screen.findByRole('region', { name: 'Narration voice' });
    fireEvent.click(within(voice).getByRole('button', { name: 'Connect Kenari' }));
    expect(await within(voice).findByRole('option', { name: 'gemini-3-1-flash-tts' })).toBeInTheDocument();
    expect(within(voice).queryByLabelText('Voice base URL')).not.toBeInTheDocument();   // auto-filled, no field to type it in
    fireEvent.change(within(voice).getByLabelText('Voice for Indonesian'), { target: { value: 'Kore' } });
    fireEvent.change(within(voice).getByLabelText('Voice API key'), { target: { value: 'kn-good' } });
    fireEvent.click(within(voice).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/voice')[0]).toEqual({
      baseUrl: 'https://kenari.id/v1', model: 'gemini-3-1-flash-tts', voices: { id: 'Kore' }, apiKey: 'kn-good',
    }));
  });

  it('custom commands: add, edit and remove rows, save the list; an install that turns them off says so and locks the card', async () => {
    state.settings = generateSettings({ commands: { commands: [{ name: 'brand-check', cmd: 'python', args: ['check.py'], timeoutSec: 30 }] } });
    const first = render(<ConnectionsPanel api={api} />);
    const box = await screen.findByRole('region', { name: 'Custom commands' });
    expect(within(box).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(box).getByRole('button', { name: 'Add a command' }));
    fireEvent.change(within(box).getByLabelText('Command 2 name'), { target: { value: 'lint' } });
    fireEvent.change(within(box).getByLabelText('Command 2 program'), { target: { value: 'node' } });
    fireEvent.change(within(box).getByLabelText('Command 2 arguments'), { target: { value: 'lint.js  --strict' } });
    fireEvent.change(within(box).getByLabelText('Command 2 time limit'), { target: { value: '90' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Remove command 1' }));
    fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/commands')[0]).toEqual({ commands: [{ name: 'lint', cmd: 'node', args: ['lint.js', '--strict'], timeoutSec: 90 }] }));
    first.unmount();

    state.settings = generateSettings({ commands: { allowed: false } });
    render(<ConnectionsPanel api={api} />);
    expect(await screen.findByText(/Custom commands are off on this install/)).toBeInTheDocument();
    const off = screen.getByRole('region', { name: 'Custom commands' });
    expect(within(off).getByRole('button', { name: 'Add a command' })).toBeDisabled();
    expect(within(off).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
