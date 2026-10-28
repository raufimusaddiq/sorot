import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { ConnectionsPanel } from '../ConnectionsPanel';
import { PublishPanel, scheduleIso } from '../PublishPanel';
import {
  emptyState, installFakeApi, makeClip, makeConnections, makePost, type FakeState,
} from '../../../test/fakeApi';
import type { Connections, DraftTarget } from '@/types';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
});

const api = new ApiClient('');
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

describe('ConnectionsPanel', () => {
  it('shows the three connections, saves only changed fields and never shows a key back', async () => {
    const changed: Connections[] = [];
    render(<ConnectionsPanel api={api} onChange={(c) => changed.push(c)} />);
    expect(screen.getByText('Loading settings…')).toBeInTheDocument();
    const llm = await screen.findByRole('region', { name: 'LLM' });
    expect(within(llm).getByText('off')).toBeInTheDocument();
    expect(within(llm).getByText(/the rules find, score and title the clips/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Jev quality gate' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tebar publishing' })).toBeInTheDocument();

    const save = within(llm).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(llm).getByLabelText('LLM Base URL'), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(within(llm).getByLabelText('LLM Model'), { target: { value: 'qwen2.5:7b' } });
    fireEvent.change(within(llm).getByLabelText('LLM API key'), { target: { value: ' sk-1234abcd ' } });
    fireEvent.click(save);
    await waitFor(() => expect(within(llm).getByText('active')).toBeInTheDocument());
    expect(sent('PUT', '/api/settings/llm')[0]).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', apiKey: 'sk-1234abcd' });
    expect(within(llm).getByLabelText('LLM API key')).toHaveValue('');
    expect(within(llm).getByLabelText('LLM API key')).toHaveAttribute('placeholder', '••••abcd (leave empty to keep)');
    expect(changed.at(-1)!.llm.active).toBe(true);

    fireEvent.click(within(llm).getByLabelText(/Director/));
    await waitFor(() => expect(within(llm).getByLabelText(/Director/)).not.toBeChecked());
    expect(sent('PUT', '/api/settings/llm')[1]).toEqual({ director: false });
    fireEvent.click(within(llm).getByRole('button', { name: 'Use .env' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/llm')[2]).toMatchObject({ baseUrl: null, model: null, apiKey: null, director: null }));
  });

  it('tests a connection and shows the result; errors are shown', async () => {
    state.settings = makeConnections({ jev: { ...makeConnections().jev, active: true, apiKeySet: true, apiKey: '••••9999' } });
    state.tests.jev = { ok: true, ms: 87, model: 'jev-1.14.0', detail: 'answered 0.97' };
    render(<ConnectionsPanel api={api} />);
    const jev = await screen.findByRole('region', { name: 'Jev quality gate' });
    fireEvent.click(within(jev).getByRole('button', { name: 'Test' }));
    expect(await within(jev).findByText('OK in 87 ms · jev-1.14.0 · answered 0.97')).toBeInTheDocument();
    const tebar = screen.getByRole('region', { name: 'Tebar publishing' });
    fireEvent.click(within(tebar).getByRole('button', { name: 'Test' }));
    expect(await within(tebar).findByText('Failed: Not configured')).toBeInTheDocument();
    state.fail['POST /api/settings/llm/test'] = 'backend down';
    const llm = screen.getByRole('region', { name: 'LLM' });
    fireEvent.click(within(llm).getByRole('button', { name: 'Test' }));
    expect(await within(llm).findByText('Failed: backend down')).toBeInTheDocument();
    state.fail['PUT /api/settings/tebar'] = 'apiKey must not contain spaces';
    fireEvent.click(within(tebar).getByLabelText(/Use Tebar publishing/));
    expect(await within(tebar).findByRole('alert')).toHaveTextContent('apiKey must not contain spaces');
  });
});

const NAMES: Record<string, string> = { tt: 'budi.tt', yt: 'Kanal', pin: 'Pins' };
const target = (accountId: string, platform: string, extra: Partial<DraftTarget> = {}): DraftTarget => ({
  accountId, platform, name: NAMES[accountId] ?? accountId, content: `copy for ${platform}`, copyBy: 'llm', needs: {}, warnings: [], blockers: [], ...extra,
});

describe('PublishPanel', () => {
  const clip = makeClip('c1', 'v1', 'PRIMARY', 1);

  beforeEach(() => {
    state.settings = makeConnections({ tebar: { ...makeConnections().tebar, active: true, apiKeySet: true, apiKey: '••••1234' } });
    state.accounts = [{ id: 'tt', platform: 'tiktok', name: 'budi.tt' }, { id: 'yt', platform: 'youtube', name: 'Kanal' },
      { id: 'pin', platform: 'pinterest', name: 'Pins' }];
    state.draft = {
      clip: { id: 'c1', title: 'Judul', gateVerdict: 'PASS', gateReasons: [] },
      copyCheckedBy: 'jev-1.14.0',
      targets: [
        target('tt', 'tiktok', { needs: { tiktokPrivacy: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, warnings: ['Jev: this copy may claim more than the clip says — check it'] }),
        target('yt', 'youtube', { title: 'Judul YT', content: 'Desk #shorts', copyBy: 'template', needs: { madeForKids: true } }),
        target('pin', 'pinterest', { blockers: ["pinterest doesn't take a single video post here"] }),
      ],
    };
  });

  it('drafts copy, requires the user-only choices, publishes with the edited copy', async () => {
    const closed = jest.fn();
    render(<PublishPanel clip={clip} api={api} onClose={closed} />);
    expect(await screen.findByText('budi.tt')).toBeInTheDocument();
    const write = screen.getByRole('button', { name: 'Write copy' });
    expect(write).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Kanal/ }));
    fireEvent.click(write);
    expect(await screen.findByText('Copy checked by jev-1.14.0.')).toBeInTheDocument();
    expect(sent('POST', '/api/clips/c1/publish/draft')[0]).toEqual({ accountIds: ['tt', 'yt'] });
    expect(screen.getByText(/may claim more than the clip says/)).toBeInTheDocument();
    expect(screen.getByLabelText('Title for Kanal')).toHaveValue('Judul YT');

    const publish = screen.getByRole('button', { name: 'Publish now' });
    expect(publish).toBeDisabled();                                    // privacy + made-for-kids not chosen yet
    fireEvent.change(screen.getByLabelText('Privacy for budi.tt'), { target: { value: 'SELF_ONLY' } });
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getAllByLabelText('No')[0]!);
    fireEvent.change(screen.getByLabelText('Text for budi.tt'), { target: { value: 'Teks baru #fyp' } });
    expect(screen.getByText('Text (14 characters)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title for Kanal'), { target: { value: '' } });
    expect(publish).toBeDisabled();                                    // YouTube needs a title
    fireEvent.change(screen.getByLabelText('Title for Kanal'), { target: { value: 'Judul final' } });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    await waitFor(() => expect(sent('POST', '/api/clips/c1/publish')).toHaveLength(1));
    expect(sent('POST', '/api/clips/c1/publish')[0]).toEqual({ targets: [
      { accountId: 'tt', content: 'Teks baru #fyp', privacyLevel: 'SELF_ONLY' },
      { accountId: 'yt', content: 'Desk #shorts', title: 'Judul final', madeForKids: false }] });
    expect(await screen.findByText('Posts of this clip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish now' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toHaveBeenCalled();
  });

  it('platform blockers stop publishing; a scheduled post sends an ISO time', async () => {
    render(<PublishPanel clip={clip} api={api} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Pins/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write copy' }));
    expect(await screen.findByText(/pinterest doesn't take a single video post here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Pins/ }));                     // deselect, pick TikTok instead
    fireEvent.click(screen.getByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite copy' }));
    fireEvent.change(await screen.findByLabelText('Privacy for budi.tt'), { target: { value: 'PUBLIC_TO_EVERYONE' } });
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: '2030-01-02T19:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(sent('POST', '/api/clips/c1/publish')).toHaveLength(1));
    expect(sent('POST', '/api/clips/c1/publish')[0]).toMatchObject({ scheduledAt: new Date('2030-01-02T19:30').toISOString() });
    expect(scheduleIso('')).toBeUndefined();
  });

  it('a gate REVIEW needs a confirmation; a FAIL needs an explicit override', async () => {
    state.draft = { ...state.draft!, clip: { id: 'c1', title: 'J', gateVerdict: 'REVIEW', gateReasons: ['may accuse a real person or company of wrongdoing'] },
      targets: [target('tt', 'tiktok')] };
    const { unmount } = render(<PublishPanel clip={clip} api={api} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write copy' }));
    const confirm = await screen.findByLabelText(/I checked it/);
    expect(screen.getByText(/may accuse a real person/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish now' })).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await waitFor(() => expect(sent('POST', '/api/clips/c1/publish')[0]).toMatchObject({ confirmReview: true }));
    unmount();

    state.draft = { ...state.draft!, clip: { id: 'c1', title: 'J', gateVerdict: 'FAIL', gateReasons: [] },
      targets: [target('tt', 'tiktok', { blockers: ['Held back by the quality gate: mostly filler'] })] };
    render(<PublishPanel clip={clip} api={api} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write copy' }));
    expect(await screen.findByText(/no reason given/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish now' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Post anyway/));
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await waitFor(() => expect(sent('POST', '/api/clips/c1/publish')[1]).toMatchObject({ override: true }));
  });

  it('lists earlier posts and refreshes them; no accounts and errors are explained', async () => {
    state.posts.c1 = [makePost('p1', 'c1', { scheduledAt: '2030-01-01T00:00:00Z', errorMessage: 'tiktok: account_expired' }),
      makePost('p2', 'c1', { targets: '{bad' })];
    state.accounts = [];
    render(<PublishPanel clip={clip} api={api} onClose={() => {}} />);
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    expect(await screen.findByText('tiktok: account_expired')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!);
    expect(await screen.findByRole('link', { name: 'open' })).toHaveAttribute('href', 'https://tiktok.com/@x/video/1');
  });

  it('shows why accounts could not load, and draft failures', async () => {
    state.fail['GET /api/social/accounts'] = 'Tebar is not connected';
    const { unmount } = render(<PublishPanel clip={clip} api={api} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tebar is not connected');
    unmount();
    delete state.fail['GET /api/social/accounts'];
    state.fail['POST /api/clips/c1/publish/draft'] = 'Pick at least one account';
    render(<PublishPanel clip={clip} api={api} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /budi.tt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one account');
  });
});
