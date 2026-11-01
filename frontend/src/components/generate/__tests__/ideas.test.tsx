import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { GenerateWindow } from '../GenerateWindow';
import { IdeaBank } from '../IdeaBank';
import { emptyState, installFakeApi, makeGenIdea, type FakeState } from '../../../../test/fakeApi';

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
const recipes = [{ id: 'quick', name: 'Quick' }, { id: 'auto', name: 'Auto' }];

describe('IdeaBank', () => {
  it('lists the ideas with their status; the run button counts the new ones', async () => {
    state.genIdeas = [makeGenIdea('a', { status: 'posted', projectId: 'pa' }), makeGenIdea('b'), makeGenIdea('c', { status: 'built', projectId: 'pc' })];
    render(<IdeaBank api={api} recipes={recipes} onOpen={jest.fn()} />);
    const items = (await screen.findAllByRole('listitem')).map((li) => li.textContent);
    expect(items[0]).toContain('posted');
    expect(items[1]).toContain('new');
    expect(items[2]).toContain('built');
    expect(screen.getByRole('button', { name: 'Run the next idea (1 waiting)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resume idea-a' })).toBeDisabled();       // posted: nothing left to do
    expect(screen.getByRole('button', { name: 'Resume idea-c' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run idea-b' })).toBeEnabled();
  });

  it('runs the next idea with the chosen recipe and opens the video; naming an idea runs that one', async () => {
    state.genIdeas = [makeGenIdea('a'), makeGenIdea('b', { status: 'used', projectId: 'pb' })];
    const onOpen = jest.fn();
    render(<IdeaBank api={api} recipes={recipes} onOpen={onOpen} />);
    fireEvent.change(await screen.findByLabelText('Recipe for the run'), { target: { value: 'auto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run the next idea (1 waiting)' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('run-a'));
    expect(sent('POST', '/api/generate/run')).toEqual([{ recipeId: 'auto' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Resume idea-b' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('pb'));
    expect(sent('POST', '/api/generate/run')[1]).toEqual({ recipeId: 'auto', ideaId: 'b' });
    fireEvent.click(screen.getByRole('button', { name: 'Open idea-b' }));
    expect(onOpen).toHaveBeenLastCalledWith('pb');
  });

  it('adds an idea (needs a name and a brief) and deletes one', async () => {
    render(<IdeaBank api={api} recipes={[{ id: 'quick', name: 'Quick' }]} onOpen={jest.fn()} />);
    expect(await screen.findByText('No ideas yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Recipe for the run')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No new ideas to run' })).toBeDisabled();
    const add = screen.getByRole('button', { name: 'Add idea' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Idea name'), { target: { value: ' bunga ' } });
    fireEvent.change(screen.getByLabelText('Idea brief'), { target: { value: ' Jelaskan bunga ' } });
    fireEvent.click(add);
    expect(await screen.findByText('Jelaskan bunga')).toBeInTheDocument();
    expect(sent('POST', '/api/generate/ideas')).toEqual([{ slug: 'bunga', brief: 'Jelaskan bunga' }]);
    await waitFor(() => expect(screen.getByLabelText('Idea name')).toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: 'Delete bunga' }));
    await waitFor(() => expect(screen.getByText('No ideas yet.')).toBeInTheDocument());
  });

  it('errors are shown: a run the server refuses, and a bank that will not load', async () => {
    state.genIdeas = [makeGenIdea('a')];
    state.fail['POST /api/generate/run'] = 'The recipe auto can\'t run here';
    const first = render(<IdeaBank api={api} recipes={recipes} onOpen={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run idea-a' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("can't run here");
    first.unmount();
    state.fail['GET /api/generate/ideas'] = 'backend down';
    render(<IdeaBank api={api} recipes={recipes} onOpen={jest.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('backend down');
  });
});

describe('GenerateWindow: ideas', () => {
  it('the Ideas link opens the bank; running an idea opens the video it made and closes the bank', async () => {
    state.genIdeas = [makeGenIdea('a')];
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByTestId('generate-ready');
    fireEvent.click(screen.getByRole('button', { name: 'Ideas' }));
    const bank = await screen.findByRole('region', { name: 'Ideas' });
    fireEvent.click(await within(bank).findByRole('button', { name: 'Run idea-a' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ideas' })).not.toBeInTheDocument());
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('run-a');
    fireEvent.click(screen.getByRole('button', { name: 'Ideas' }));
    fireEvent.click(await screen.findByRole('button', { name: '← Back to videos' }));
    await screen.findByTestId('generate-ready');
  });
});
