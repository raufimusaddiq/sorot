import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Studio from '@/app/studio/page';
import { ApiClient } from '@/lib/api';
import { GenerateWindow } from '../GenerateWindow';
import { emptyState, installFakeApi, makeGenerateStatus, type FakeState } from '../../../../test/fakeApi';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const api = new ApiClient('');

describe('GenerateWindow', () => {
  it('shows where Generate will render when it is ready', async () => {
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByTestId('generate-ready')).toHaveTextContent('HyperFrames 0.8.223 · rendering on the GPU');
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect an LLM in Settings' })).not.toBeInTheDocument();
  });

  it('without an LLM it says so and links to Settings (FR-016)', async () => {
    state.generate = makeGenerateStatus({ available: false, llm: { configured: false }, reasons: ['Connect an LLM in Settings: Generate needs one'] });
    const onOpenSettings = jest.fn();
    render(<GenerateWindow api={api} onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText('Generate isn’t available yet')).toBeInTheDocument();
    expect(screen.getByText(/Connect an LLM in Settings: Generate needs one/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect an LLM in Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('with an LLM but a broken HyperFrames it lists the reason without the Settings button', async () => {
    state.generate = makeGenerateStatus({ available: false, reasons: ['HyperFrames needs Chrome (not found)'] });
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} />);
    expect(await screen.findByText('HyperFrames needs Chrome (not found)')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the error when the status call fails', async () => {
    state.fail['GET /api/generate/status'] = 'backend down';
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('backend down');
  });

  it('is an app in the studio dock; its Settings button opens Settings', async () => {
    state.generate = makeGenerateStatus({ available: false, llm: { configured: false }, reasons: ['Connect an LLM in Settings'] });
    render(<Studio />);
    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an LLM in Settings' }));
    expect(await screen.findByRole('region', { name: 'LLM' })).toBeInTheDocument();
    expect(fake.calls.some((c) => c.path === '/api/generate/status')).toBe(true);
  });
});
