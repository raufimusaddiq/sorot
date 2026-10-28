import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { ConnectionsPanel } from '../ConnectionsPanel';
import { PublishPanel, scheduleIso } from '../PublishPanel';
import { emptyState, installFakeApi, makeClip, makePost, type FakeState } from '../../../test/fakeApi';
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

const ACCOUNTS = [{ id: 'tt', platform: 'tiktok', name: 'budi.tt' }, { id: 'yt', platform: 'youtube', name: 'Kanal' }, { id: 'pin', platform: 'pinterest', name: 'Pins' }];
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

  beforeEach(() => {
    state.accounts = ACCOUNTS;
    state.draft = { clip: { id: 'c1', title: 'Judul', gateVerdict: 'PASS', gateReasons: [] }, copyCheckedBy: 'jev-1.14.0', targets: [
      target('tt', { needs: { tiktokPrivacy: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, warnings: ['Jev: this copy may claim more than the clip says — check it'] }),
      target('yt', { title: 'Judul YT', content: 'Desk #shorts', copyBy: 'template', needs: { madeForKids: true } }),
      target('pin', { blockers: ["pinterest doesn't take a single video post here"] })] };
  });

  it('drafts copy; platform blockers and the user-only choices hold publishing; schedules the edited copy', async () => {
    const closed = jest.fn();
    open(closed);
    expect(await screen.findByRole('button', { name: 'Write copy' })).toBeDisabled();   // no account ticked yet
    await writeCopy('Pins');
    expect(await screen.findByText(/pinterest doesn't take a single video post here/)).toBeInTheDocument();
    expect(publishNow()).toBeDisabled();
    await writeCopy('Pins', 'budi.tt', 'Kanal');                                        // swap Pinterest for TikTok + YouTube
    expect(await screen.findByLabelText('Title for Kanal')).toHaveValue('Judul YT');
    expect(sent('POST', '/api/clips/c1/publish/draft')).toEqual([{ accountIds: ['pin'] }, { accountIds: ['tt', 'yt'] }]);
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
      { accountId: 'tt', content: 'Teks baru #fyp', privacyLevel: 'SELF_ONLY' },
      { accountId: 'yt', content: 'Desk #shorts', title: 'Judul final', madeForKids: false }] }]));
    expect(await screen.findByText('Posts of this clip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(scheduleIso('')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toHaveBeenCalled();
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
    await waitFor(() => expect(posted()).toEqual([{ targets: [{ accountId: 'tt', content: 'copy for tiktok' }], ...flag }]));
  });

  it('lists earlier posts and refreshes them; no accounts is explained', async () => {
    state.posts.c1 = [makePost('p1', 'c1', { scheduledAt: '2030-01-01T00:00:00Z', errorMessage: 'tiktok: account_expired' }),
      makePost('p2', 'c1', { targets: '{bad' })];
    state.accounts = [];
    open();
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    expect(await screen.findByText('tiktok: account_expired')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!);
    expect(await screen.findByRole('link', { name: 'open' })).toHaveAttribute('href', 'https://tiktok.com/@x/video/1');
  });

  it.each([
    ['GET /api/social/accounts', 'Tebar is not connected', []],
    ['POST /api/clips/c1/publish/draft', 'Pick at least one account', ['budi.tt']],
  ])('shows the error when %s fails', async (route, error, accounts) => {
    state.fail[route] = error;
    open();
    if (accounts.length) await writeCopy(...accounts);
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
  });
});
