import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { ModelsCard } from '../../GenerateConnections';
import { KitPanel } from '../KitPanel';
import { lookLine, PlanEditor } from '../PlanEditor';
import { emptyState, installFakeApi, makeGenPlan, makeKitPart, makePlanRow, type FakeState } from '../../../../test/fakeApi';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  window.confirm = jest.fn(() => true);
});
afterEach(() => jest.restoreAllMocks());

const api = new ApiClient('');
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

describe('KitPanel', () => {
  it('lists the parts; yours can be removed, built-ins only exported; a .zip is added and the list follows', async () => {
    state.genKit = [...state.genKit, makeKitPart('glow', 'user')];
    render(<KitPanel api={api} />);
    const list = await screen.findByRole('list', { name: 'Kit parts' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split('Export')[0])).toEqual([
      'shade1.0.0 · domb', 'three1.0.0 · webgl · GPU preferredb', 'glow1.0.0 · domy',
    ].map((t) => t.replace(/b$/, 'built in').replace(/y$/, 'yours')));
    expect(within(list).getAllByRole('link', { name: 'Export' })[0]).toHaveAttribute('href', '/api/generate/kit/shade/export');
    expect(within(list).queryByRole('button', { name: 'Remove shade' })).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove glow' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed glow.'));
    fireEvent.change(screen.getByLabelText('Kit part .zip'), { target: { files: [new File(['zip'], 'neon.zip')] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added neon 1.0.0'));
    expect(within(screen.getByRole('list', { name: 'Kit parts' })).getByText('neon')).toBeInTheDocument();
  });

  it("a part that doesn't pass shows the server's findings", async () => {
    state.fail['POST /api/generate/kit'] = "The part's example didn't pass: two renders of the example differ";
    render(<KitPanel api={api} />);
    await screen.findByRole('list', { name: 'Kit parts' });
    fireEvent.change(screen.getByLabelText('Kit part .zip'), { target: { files: [new File(['zip'], 'bad.zip')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('two renders of the example differ');
  });
});

describe('ModelsCard', () => {
  it("shows each model's record and auto level; a pin is sent; Calibrate reports each level", async () => {
    state.genModels.models[0]!.records = [{ model: 'm1', level: 'compose', asked: 10, firstPass: 8, repaired: 1, dropped: 0, malformed: 1, ms: 1000, calibratedAt: null }];
    render(<ModelsCard api={api} />);
    const m1 = await screen.findByLabelText('Model m1');
    expect(within(m1).getByRole('option', { name: 'auto (starts at kit)' })).toBeInTheDocument();
    expect(within(m1).getByRole('row', { name: /compose/ })).toHaveTextContent('compose1080%10%01');
    fireEvent.change(within(m1).getByLabelText('m1 level'), { target: { value: 'compose' } });
    await waitFor(() => expect(sent('PUT', '/api/generate/models/m1/level')).toEqual([{ level: 'compose' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Calibrate m1' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Calibrate m1' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Calibrated m1: kit 3/3 · compose 2/3');
  });
});

describe('PlanEditor: levels and looks', () => {
  it('shows each shot\'s level (the owner may change it before approving) and its look in one line', () => {
    const plan = makeGenPlan();
    plan.shots[0] = { ...plan.shots[0]!, level: 'kit', look: { description: 'a lit coin', values: { lightAngleDeg: 300, speed: 'fast' }, parts: [{ part: 'shade', settings: {} }] } };
    const onSave = jest.fn();
    render(<PlanEditor plans={[makePlanRow('pl1', 1, plan)]} targetSec={30} busy={false} onSave={onSave} onRevise={jest.fn()} onApprove={jest.fn()} />);
    expect(screen.getByLabelText('Shot 1 look')).toHaveTextContent('Look: a lit coin · lightAngleDeg 300, speed fast · parts: shade');
    expect(screen.queryByLabelText('Shot 2 level')).not.toBeInTheDocument();   // a plan from before levels
    fireEvent.change(screen.getByLabelText('Shot 1 level'), { target: { value: 'compose' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save my edits' }));
    expect(onSave.mock.calls[0][0].shots[0].level).toBe('compose');
    expect(lookLine({ description: 'plain', values: {} })).toBe('plain');
  });
});
