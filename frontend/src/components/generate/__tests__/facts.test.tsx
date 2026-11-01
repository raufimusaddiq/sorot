import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { BriefForm } from '../BriefForm';
import { FactsPanel } from '../FactsPanel';
import { GenerateWindow } from '../GenerateWindow';
import {
  emptyState, installFakeApi, makeGenFact, makeGenPlan, makeGenProject, makeGenRecipe, makePlanRow, makeStoryline, type FakeState,
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
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

describe('FactsPanel', () => {
  it('lists each fact with its status, source, evidence and, for a correction, the value it had', async () => {
    state.genFacts.g1 = [
      makeGenFact('a', { status: 'verified', evidence: 'sebesar 5,75 persen' }),
      makeGenFact('b', { claim: 'Inflasi 2,8 persen', status: 'corrected', value: '2,8%', originalValue: '3%', evidence: 'inflasi 2,8 persen', addedBy: 'director' }),
      makeGenFact('c', { claim: 'Kurs naik', value: null, status: 'unverifiable', evidence: 'the source can\'t be read', sourceUrl: 'data:bi' }),
      makeGenFact('d', { claim: 'Belum dicek' }),
    ];
    render(<FactsPanel api={api} projectId="g1" />);
    const items = (await screen.findAllByRole('listitem')).map((li) => li.textContent);
    expect(items[0]).toContain('verified');
    expect(items[0]).toContain('Evidence: “sebesar 5,75 persen”');
    expect(items[1]).toContain('corrected');
    expect(items[1]).toContain('Was: 3%');
    expect(items[1]).toContain('added by director');
    expect(items[2]).toContain('Why: “the source can\'t be read”');
    expect(items[2]).toContain('Source: data:bi');
    expect(items[3]).toContain('not checked');
    expect(screen.getAllByRole('link', { name: 'https://bi.go.id/rapat' })).toHaveLength(3);   // every fact with a web source links to it
    expect(screen.getByRole('button', { name: 'Check 1 against their sources' })).toBeInTheDocument();
  });

  it('checks against the sources and shows the result', async () => {
    state.genFacts.g1 = [makeGenFact('a')];
    render(<FactsPanel api={api} projectId="g1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check 1 against their sources' }));
    expect(await screen.findByText(/Evidence: “Bank Indonesia menetapkan/)).toBeInTheDocument();
    expect(sent('POST', '/api/generate/projects/g1/facts/verify')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Check again against the sources' })).toBeInTheDocument();
  });

  it('adds a fact (needs a claim and a source), edits it (back to unchecked) and deletes it', async () => {
    render(<FactsPanel api={api} projectId="g1" />);
    expect(await screen.findByText('No facts yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again against the sources' })).toBeDisabled();
    const add = screen.getByRole('button', { name: 'Add fact' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New claim'), { target: { value: 'Bunga acuan 5,75 persen' } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New source address'), { target: { value: 'https://bi.go.id/x' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: '5,75%' } });
    fireEvent.click(add);
    expect(await screen.findByText('Bunga acuan 5,75 persen')).toBeInTheDocument();
    expect(sent('POST', '/api/generate/projects/g1/facts')).toEqual([{ claim: 'Bunga acuan 5,75 persen', value: '5,75%', sourceUrl: 'https://bi.go.id/x' }]);
    expect(screen.getByLabelText('New claim')).toHaveValue('');

    state.genFacts.g1![0] = { ...state.genFacts.g1![0]!, status: 'verified', evidence: 'x' };
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bunga acuan 5,75 persen' }));
    fireEvent.change(screen.getByLabelText('Claim'), { target: { value: 'Bunga acuan 6 persen' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '6%' } });
    fireEvent.change(screen.getByLabelText('Source address'), { target: { value: 'https://bi.go.id/y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Bunga acuan 6 persen')).toBeInTheDocument();
    expect(sent('PATCH', '/api/generate/facts/fact1')).toEqual([{ claim: 'Bunga acuan 6 persen', value: '6%', sourceUrl: 'https://bi.go.id/y' }]);
    expect(within(screen.getAllByRole('listitem')[0]!).getByText('not checked')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Bunga acuan 6 persen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Bunga acuan 6 persen' }));
    await waitFor(() => expect(screen.getByText('No facts yet.')).toBeInTheDocument());
  });

  it('errors are shown (the server refusing a fact, or the list not loading); a busy video locks the buttons', async () => {
    state.fail['POST /api/generate/projects/g1/facts'] = 'sourceUrl: give the web address';
    const first = render(<FactsPanel api={api} projectId="g1" busy />);
    await screen.findByText('No facts yet.');
    fireEvent.change(screen.getByLabelText('New claim'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('New source address'), { target: { value: 'https://x.id' } });
    expect(screen.getByRole('button', { name: 'Add fact' })).toBeEnabled();
    first.unmount();
    render(<FactsPanel api={api} projectId="g1" />);
    await screen.findByText('No facts yet.');
    fireEvent.change(screen.getByLabelText('New claim'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('New source address'), { target: { value: 'https://x.id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add fact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('give the web address');
  });

  it('a list that will not load says why', async () => {
    state.fail['GET /api/generate/projects/g1/facts'] = 'backend down';
    render(<FactsPanel api={api} projectId="g1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('backend down');
  });
});

describe('BriefForm: facts and numbers', () => {
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Plan my video' }));
  const fill = () => fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'Jelaskan suku bunga' } });

  it('facts are written one per line as claim | value | address; no numbers beyond the brief is a tick', () => {
    const onCreate = jest.fn();
    render(<BriefForm busy={false} onCreate={onCreate} />);
    fill();
    submit();
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('facts');
    fireEvent.change(screen.getByLabelText('Facts'), { target: { value: 'Bunga acuan 5,75 persen | 5,75% | https://bi.go.id/a\n\nInflasi rendah | https://bps.go.id/b\n' } });
    fireEvent.click(screen.getByLabelText('No other numbers'));
    submit();
    expect(onCreate.mock.calls[1]![0]).toMatchObject({
      facts: [{ claim: 'Bunga acuan 5,75 persen', value: '5,75%', sourceUrl: 'https://bi.go.id/a' }, { claim: 'Inflasi rendah', sourceUrl: 'https://bps.go.id/b' }],
      forbiddenNumbers: true,
    });
  });

  it('a line without an address is explained and nothing is sent', () => {
    const onCreate = jest.fn();
    render(<BriefForm busy={false} onCreate={onCreate} />);
    fill();
    fireEvent.change(screen.getByLabelText('Facts'), { target: { value: 'Bunga acuan 5,75 persen | 5,75%' } });
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('write each fact as claim | value | https://address');
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('GenerateWindow: facts', () => {
  it('a project whose recipe checks facts shows the panel; one that does not, does not', async () => {
    const plan = makePlanRow('pl1', 1, makeGenPlan());
    const recipe = (steps: Array<{ use: string }>) => ({ steps });
    const mk = (id: string, steps: Array<{ use: string }>) => ({
      project: { ...makeGenProject(id, { storylines: [makeStoryline(1)], currentPlanId: 'pl1' }), recipe: recipe(steps) }, plans: [{ ...plan, projectId: id }], versions: [], assets: [], exports: [],
    });
    state.genRecipes = [makeGenRecipe('quick', true)];
    state.genProjects = [mk('g1', [{ use: 'facts' }, { use: 'plan' }])];
    state.genFacts.g1 = [makeGenFact('a')];
    const first = render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByTestId('generate-ready');
    expect(await screen.findByRole('region', { name: 'Facts' })).toBeInTheDocument();
    first.unmount();
    state.genProjects = [mk('g1', [{ use: 'plan' }])];
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByTestId('generate-ready');
    await screen.findByText('Plan, revision 1');
    expect(screen.queryByRole('region', { name: 'Facts' })).not.toBeInTheDocument();
  });
});
