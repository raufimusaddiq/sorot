import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ApiClient } from '@/lib/api';
import { ClipEditor } from '../ClipEditor';
import { FALLBACK_CHOICES, ImportOptions, type ImportSettings } from '../ImportOptions';
import { emptyState, installFakeApi, makeClip, type FakeState } from '../../../test/fakeApi';
import type { Clip, EditChoices } from '@/types';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
});

const choices: EditChoices = { ...FALLBACK_CHOICES, music: ['lofi.mp3', 'upbeat.m4a'] };

function ImportHarness({ onValue }: { onValue: (v: ImportSettings) => void }) {
  const [value, setValue] = useState<ImportSettings>({ options: {}, startTime: '', endTime: '' });
  return <ImportOptions value={value} choices={choices} onChange={(v) => { setValue(v); onValue(v); }} />;
}

describe('ImportOptions', () => {
  it('is collapsed until opened and edits every option', () => {
    let last: ImportSettings | null = null;
    render(<ImportHarness onValue={(v) => { last = v; }} />);
    expect(screen.queryByLabelText('Caption style')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Options/ }));

    fireEvent.change(screen.getByLabelText('Caption style'), { target: { value: 'hormozi' } });
    fireEvent.change(screen.getByLabelText('Framing'), { target: { value: 'blur' } });
    fireEvent.click(screen.getByLabelText('Cut silences'));
    fireEvent.click(screen.getByLabelText(/Hook first/));
    expect(screen.queryByLabelText(/including auto-generated/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Use YouTube captions/));
    fireEvent.click(screen.getByLabelText(/including auto-generated/));
    expect(screen.queryByLabelText('Music volume')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Background music'), { target: { value: 'lofi.mp3' } });
    fireEvent.change(screen.getByLabelText('Music volume'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '1:00' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2:30' } });
    fireEvent.change(screen.getByLabelText('Direction for the LLM'), { target: { value: 'cuma yang lucu' } });

    expect(last).toEqual({
      options: { style: 'hormozi', reframe: 'blur', silenceTrim: true, hookFirst: true, youtubeCaptions: true,
        allowAutoCaptions: true, bgm: 'lofi.mp3', bgmVolume: 0.3, direction: 'cuma yang lucu' },
      startTime: '1:00', endTime: '2:30',
    });
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Follow faces' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Options/ }));
    expect(screen.queryByLabelText('Framing')).not.toBeInTheDocument();
  });

  it('explains where music comes from when there is none, and labels unknown modes', () => {
    render(<ImportOptions value={{ options: {}, startTime: '', endTime: '' }} onChange={() => {}}
      choices={{ ...FALLBACK_CHOICES, reframeModes: ['face', 'zoom'] }} />);
    fireEvent.click(screen.getByRole('button', { name: /Options/ }));
    expect(screen.getByText(/to use them/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'zoom' })).toBeInTheDocument();
  });
});

describe('ClipEditor', () => {
  const api = new ApiClient('');
  const base = (extra: Partial<Clip> = {}) => makeClip('c1', 'v1', 'PRIMARY', 1, { startTime: 30, endTime: 55, ...extra });

  function open(clip: Clip, handlers: { onClose?: () => void; onSaved?: (c: Clip) => void } = {}) {
    state.clips.v1 = [clip];
    return render(<ClipEditor clip={clip} api={api} choices={choices}
      onClose={handlers.onClose ?? (() => {})} onSaved={handlers.onSaved ?? (() => {})} />);
  }

  it('loads captions, edits timing, options and words, then re-renders', async () => {
    state.captions.c1 = { edited: false, words: [{ text: 'halo', start: 31, end: 31.5 }, { text: 'mongol', start: 32, end: 32.4 }] };
    const saved: Clip[] = [];
    open(base({ options: '{"style":"storyteller"}' }), { onSaved: (c) => saved.push(c) });
    expect(screen.getByText('Loading captions…')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('mongol')).toBeInTheDocument();
    expect(screen.getByLabelText('Clip caption style')).toHaveValue('storyteller');   // saved override

    fireEvent.click(screen.getAllByRole('button', { name: '−0.5s' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '+0.5s' })[1]!);
    fireEvent.change(screen.getByLabelText('End seconds'), { target: { value: '57' } });
    expect(screen.getByText('Length 27.5 s')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Clip framing'), { target: { value: 'center' } });
    fireEvent.click(screen.getByLabelText('Cut silences'));
    fireEvent.click(screen.getByLabelText('Hook first'));
    fireEvent.change(screen.getByLabelText('Background music'), { target: { value: 'upbeat.m4a' } });
    fireEvent.change(screen.getByLabelText('Word 2'), { target: { value: 'Mongol' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save & re-render' })); });
    const body = fake.calls.find(c => c.path === '/api/clips/c1/rerender')!.body;
    expect(body).toEqual({
      startTime: 29.5, endTime: 57,
      options: { style: 'storyteller', reframe: 'center', silenceTrim: true, hookFirst: true, bgm: 'upbeat.m4a' },
      captionWords: [{ text: 'halo', start: 31, end: 31.5 }, { text: 'Mongol', start: 32, end: 32.4 }],
    });
    expect(saved[0]!.updatedAt).toBe('2026-10-27T12:00:00.000Z');
  });

  it('unchanged words are not sent; reset clears an earlier edit', async () => {
    state.captions.c1 = { edited: true, words: [{ text: 'Halo', start: 31, end: 31.5 }] };
    open(base());
    expect(await screen.findByText('(edited)')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save & re-render' })); });
    expect(fake.calls.at(-1)!.body).not.toHaveProperty('captionWords');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to transcript' }));
    expect(screen.getByText(/regenerated from the transcript/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Halo')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save & re-render' })); });
    expect(fake.calls.at(-1)!.body).toMatchObject({ captionWords: null });
  });

  it('cleared words are highlighted; a clip with no speech says so', async () => {
    state.captions.c1 = { edited: false, words: [{ text: 'eh', start: 31, end: 31.2 }] };
    const { unmount } = open(base());
    const word = await screen.findByDisplayValue('eh');
    fireEvent.change(word, { target: { value: '' } });
    expect(screen.getByLabelText('Word 1').className).toContain('border-error');
    unmount();
    state.captions.c1 = { edited: false, words: [] };
    open(base());
    expect(await screen.findByText('No speech in this clip.')).toBeInTheDocument();
  });

  it('blocks invalid lengths and shows load and save errors', async () => {
    state.fail['GET /api/clips/c1/captions'] = 'Transcript not available yet';
    const closed = jest.fn();
    open(base({ options: '{broken' }), { onClose: closed });
    expect(await screen.findByText('Transcript not available yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Clip caption style')).toHaveValue('default');        // corrupt options ignored

    fireEvent.change(screen.getByLabelText('End seconds'), { target: { value: '31' } });
    expect(screen.getByText(/must be 3–180 s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & re-render' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('End seconds'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Start seconds'), { target: { value: '40' } });

    state.fail['POST /api/clips/c1/rerender'] = 'Re-render failed: nvenc died';
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save & re-render' })); });
    expect(screen.getByText('Re-render failed: nvenc died')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('non-object saved options and late caption responses are ignored', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (...args: Parameters<typeof fetch>) => { await gate; return realFetch(...args); }) as unknown as typeof fetch;
    const { unmount } = open(base({ options: '[1,2]' }));
    expect(screen.getByLabelText('Clip caption style')).toHaveValue('default');
    unmount();
    resolve();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });
});
