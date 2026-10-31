import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { aboutTime, BuildPanel } from '../BuildPanel';
import { GenerateWindow } from '../GenerateWindow';
import { VerdictPanel, where } from '../VerdictPanel';
import {
  emptyState, installFakeApi, makeFinding, makeGenPlan, makeGenProject, makeGenVersion, makePlanRow, makeStoryline, makeVerdict, type FakeState,
} from '../../../../test/fakeApi';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const api = new ApiClient('');
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path);
const card = (kind: string) => screen.getByRole('region', { name: `${kind} verdict` });

describe('VerdictPanel', () => {
  it('shows both verdicts side by side, with findings worst first, with shot and time and the fix', () => {
    render(<VerdictPanel verdicts={[
      makeVerdict('TECHNICAL', 'FAIL', [
        makeFinding('a', { severity: 'polish', description: 'A nit.' }),
        makeFinding('b', { severity: 'must-fix', shotId: 's02', fromSec: 4.2, toSec: 5, description: 'Text is too small.', suggestedFix: 'Make it 40 px.' }),
        makeFinding('c', { severity: 'should-fix', shotId: 's03', fromSec: 12, description: 'Nothing moves.' }),
      ]),
      makeVerdict('CREATIVE', 'REVIEW', [makeFinding('d', { severity: 'should-fix', description: 'The opening is a plain title.' })], { judgedBy: 'jev:jev-1.14.0' }),
    ]} />);
    const tech = card('TECHNICAL');
    expect(within(tech).getByText('FAIL')).toBeInTheDocument();
    expect(within(tech).getByText('Judged by code.')).toBeInTheDocument();
    expect(within(tech).getByText(/A FAIL blocks the export/)).toBeInTheDocument();
    const items = within(tech).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'must-fixs02 · 4.2 to 5 sText is too small.Fix: Make it 40 px.', 'should-fixs03 · 12 sNothing moves.', 'polishA nit.',
    ]);
    const creative = card('CREATIVE');
    expect(within(creative).getByText('REVIEW')).toBeInTheDocument();
    expect(within(creative).getByText('Judged by jev:jev-1.14.0.')).toBeInTheDocument();
    expect(within(creative).getByText(/never blocks/)).toBeInTheDocument();
    expect(within(creative).getByText('The opening is a plain title.')).toBeInTheDocument();
  });

  it('a passing verdict says there is nothing to fix; warnings kept on purpose are listed apart, with their reason', () => {
    render(<VerdictPanel verdicts={[
      makeVerdict('TECHNICAL', 'PASS', [
        makeFinding('k1', { severity: 'should-fix', state: 'kept', code: 'sweep_static', shotId: 's01', keptReason: 'a still title card' }),
        makeFinding('k2', { severity: 'should-fix', state: 'kept', code: 'dead_stretch' }),
      ]),
      makeVerdict('CREATIVE', 'PASS'),
    ]} />);
    expect(within(card('CREATIVE')).getByText('Nothing to fix.')).toBeInTheDocument();
    const tech = card('TECHNICAL');
    expect(within(tech).getByText('Nothing to fix.')).toBeInTheDocument();
    expect(within(tech).getByText('Kept on purpose')).toBeInTheDocument();
    expect(within(tech).getByText('sweep_static (s01): a still title card')).toBeInTheDocument();
    expect(within(tech).getByText('dead_stretch: no reason given')).toBeInTheDocument();
  });

  it('a verdict that has not run yet says so', () => {
    render(<VerdictPanel verdicts={[makeVerdict('TECHNICAL', 'PASS')]} />);
    expect(within(card('CREATIVE')).getByText('not judged yet')).toBeInTheDocument();
  });

  it('formats where a finding is, and how long a build takes', () => {
    expect([where({ shotId: null }), where({ shotId: 's01' }), where({ shotId: null, fromSec: 3 }), where({ shotId: 's02', fromSec: 1, toSec: 2 })])
      .toEqual(['', 's01', '3 s', 's02 · 1 to 2 s']);
    expect([aboutTime(30), aboutTime(89), aboutTime(90), aboutTime(600)]).toEqual(['about 30 s', 'about 89 s', 'about 2 min', 'about 10 min']);
  });
});

describe('BuildPanel', () => {
  const props = (over: Partial<React.ComponentProps<typeof BuildPanel>> = {}) => ({
    api, project: makeGenProject('g1'), version: null, verdicts: [], estimate: { draftSec: 600, exportSec: 30 }, busy: false,
    onBuild: jest.fn(), onCancel: jest.fn(), onAccept: jest.fn(), ...over,
  });

  it('offers a build with its estimate; a finished one can be built again', () => {
    const first = props();
    const { rerender } = render(<BuildPanel {...first} />);
    expect(screen.getByText('about 10 min')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build a draft' }));
    expect(first.onBuild).toHaveBeenCalledTimes(1);
    rerender(<BuildPanel {...props({ version: makeGenVersion('ver1'), estimate: null })} />);
    expect(screen.getByRole('button', { name: 'Build again' })).toBeInTheDocument();
  });

  it.each([
    ['QUEUED', null, 0, 'Waiting in the queue…'],
    ['BUILDING', 'author', 20, 'Writing the scenes…'],
    ['BUILDING', 'render', 60, 'Rendering the video…'],
    ['BUILDING', 'creative', 90, 'Judging it…'],
    ['BUILDING', 'something-new', 5, 'Building…'],
  ] as const)('a %s build at %s shows its progress and can be cancelled', (status, step, progress, label) => {
    const p = props({ version: makeGenVersion('ver1', { status, step, progress }) });
    render(<BuildPanel {...p} />);
    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(progress));
    expect(screen.queryByRole('button', { name: /Build/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the build' }));
    expect(p.onCancel).toHaveBeenCalledWith('ver1');
  });

  it('a progress bar with no number starts at zero', () => {
    render(<BuildPanel {...props({ version: makeGenVersion('ver1', { status: 'BUILDING', progress: null, step: 'check' }) })} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('a built version shows its video and both verdicts, and can be accepted', () => {
    const p = props({ version: makeGenVersion('ver1'), verdicts: [makeVerdict('TECHNICAL', 'PASS'), makeVerdict('CREATIVE', 'REVIEW')] });
    render(<BuildPanel {...p} />);
    expect(screen.getByText('Version 1 · draft render')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft video')).toHaveAttribute('src', '/api/generate/versions/ver1/draft');
    expect(card('CREATIVE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept this version' }));
    expect(p.onAccept).toHaveBeenCalledWith('ver1');
  });

  it('a TECHNICAL FAIL blocks accepting and says why; a final render and a wide video are shown as such', () => {
    const { rerender } = render(<BuildPanel {...props({ version: makeGenVersion('ver1', { renderKind: 'final' }), verdicts: [makeVerdict('TECHNICAL', 'FAIL')], project: makeGenProject('g1', { format: '16:9' }) })} />);
    expect(screen.getByRole('button', { name: 'Accept this version' })).toBeDisabled();
    expect(screen.getByText('TECHNICAL failed: fix the must-fix findings first.')).toBeInTheDocument();
    expect(screen.getByText('Version 1 · final render')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft video').className).toContain('max-w-full');
    rerender(<BuildPanel {...props({ version: makeGenVersion('ver1', { draftPath: null }), verdicts: [] })} />);
    expect(screen.queryByLabelText('Draft video')).not.toBeInTheDocument();
  });

  it('an accepted project says so instead of offering to accept', () => {
    render(<BuildPanel {...props({ project: makeGenProject('g1', { status: 'ACCEPTED' }), version: makeGenVersion('ver1'), verdicts: [makeVerdict('TECHNICAL', 'PASS')] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Accepted ✓');
    expect(screen.queryByRole('button', { name: 'Accept this version' })).not.toBeInTheDocument();
  });

  it('a failed or cancelled build says what happened', () => {
    const { rerender } = render(<BuildPanel {...props({ version: makeGenVersion('ver1', { status: 'FAILED', errorMessage: 'chrome crashed' }) })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The build stopped: chrome crashed. The scenes already written are kept.');
    rerender(<BuildPanel {...props({ version: makeGenVersion('ver1', { status: 'CANCELLED' }) })} />);
    expect(screen.getByText('The last build was cancelled.')).toBeInTheDocument();
  });
});

describe('GenerateWindow: building', () => {
  const approvedProject = (extra: Partial<FakeState['genProjects'][number]> = {}) => {
    const plan = makePlanRow('pl1', 1, makeGenPlan(), { approvedAt: '2026-01-01' });
    state.genProjects = [{
      project: makeGenProject('g1', { storylines: [makeStoryline(1)], currentPlanId: 'pl1' }), plans: [plan], versions: [], assets: [], exports: [], ...extra,
    }];
  };
  const open = async () => {
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByTestId('generate-ready');
  };

  it('an approved plan can be built: the estimate shows, the build starts, its progress is followed, then the verdicts appear and it can be accepted', async () => {
    approvedProject();
    await open();
    expect(await screen.findByText('about 10 min')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build a draft' }));
    await waitFor(() => expect(screen.getByText('Waiting in the queue…')).toBeInTheDocument());
    expect(sent('POST', '/api/generate/projects/g1/versions')).toHaveLength(1);

    // the build moves on: the window keeps polling and shows the step
    const detail = state.genProjects[0]!;
    detail.versions[0] = { ...detail.versions[0]!, status: 'BUILDING', step: 'render', progress: 60 };
    expect(await screen.findByText('Rendering the video…')).toBeInTheDocument();

    // and finishes: the video and both verdicts
    state.genVerdicts.ver1 = [makeVerdict('TECHNICAL', 'PASS'), makeVerdict('CREATIVE', 'REVIEW', [makeFinding('c1', { severity: 'polish', description: 'Pace drags.' })])];
    detail.versions[0] = { ...detail.versions[0]!, status: 'BUILT', step: null, progress: 100 };
    detail.project.status = 'BUILT';
    expect(await screen.findByLabelText('Draft video')).toBeInTheDocument();
    expect(await screen.findByText('Pace drags.')).toBeInTheDocument();
    expect(card('TECHNICAL')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Accept this version' }));
    expect(await screen.findByText('Accepted ✓')).toBeInTheDocument();
    expect(sent('POST', '/api/generate/versions/ver1/accept')).toHaveLength(1);
  });

  it('a build can be cancelled while it runs', async () => {
    approvedProject({ versions: [makeGenVersion('ver1', { status: 'BUILDING', step: 'author', progress: 20 })] });
    state.genProjects[0]!.project.status = 'BUILDING';
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the build' }));
    await waitFor(() => expect(screen.getByText('The last build was cancelled.')).toBeInTheDocument());
    expect(sent('POST', '/api/generate/versions/ver1/cancel')).toHaveLength(1);
  });

  it('accepting a build whose TECHNICAL failed is refused by the server and the error is shown', async () => {
    approvedProject({ versions: [makeGenVersion('ver1')] });
    state.genVerdicts.ver1 = [makeVerdict('TECHNICAL', 'REVIEW'), makeVerdict('CREATIVE', 'PASS')];
    await open();
    await screen.findByLabelText('Draft video');
    state.genVerdicts.ver1 = [makeVerdict('TECHNICAL', 'FAIL'), makeVerdict('CREATIVE', 'PASS')];
    fireEvent.click(screen.getByRole('button', { name: 'Accept this version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TECHNICAL failed');
  });

  it('there is nothing to build before the plan is approved, and errors from the build call are shown', async () => {
    state.genProjects = [{ project: makeGenProject('g1', { currentPlanId: 'pl1' }), plans: [makePlanRow('pl1', 1, makeGenPlan())], versions: [], assets: [], exports: [] }];
    const first = render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByText('Plan, revision 1');
    expect(screen.queryByRole('button', { name: 'Build a draft' })).not.toBeInTheDocument();
    first.unmount();

    approvedProject();
    state.fail['POST /api/generate/projects/g1/versions'] = 'Approve the plan first';
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Build a draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Approve the plan first');
  });
});
