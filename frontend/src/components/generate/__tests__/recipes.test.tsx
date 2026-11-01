import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiClient } from '@/lib/api';
import { GenerateWindow } from '../GenerateWindow';
import { FieldInput, RecipeEditor } from '../RecipeEditor';
import { emptyState, installFakeApi, makeGenRecipe, type FakeState } from '../../../../test/fakeApi';

let state: FakeState;
let fake: ReturnType<typeof installFakeApi>;
beforeEach(() => {
  state = emptyState();
  fake = installFakeApi(state);
  state.genRecipes = [makeGenRecipe('quick', true), makeGenRecipe('mine')];
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const api = new ApiClient('');
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
const open = async (id = 'mine') => {
  render(<RecipeEditor api={api} />);
  await screen.findByRole('option', { name: /mine/ });
  if (id !== 'quick') fireEvent.change(screen.getByRole('combobox', { name: 'Recipe' }), { target: { value: id } });
  await screen.findByLabelText('Recipe name');
};
const order = () => screen.getAllByRole('listitem').map((li) => /\d\. (\w+)/.exec(li.textContent ?? '')![1]);
const save = () => screen.getByRole('button', { name: 'Save recipe' });

describe('RecipeEditor', () => {
  it('an example is read-only until copied; the copy is named by you and opens for editing', async () => {
    jest.spyOn(window, 'prompt').mockReturnValue('mine-2');
    await open('quick');
    expect(screen.getByText(/An example: copy it to change it/)).toBeInTheDocument();
    expect(screen.getByLabelText('Recipe name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to edit' }));
    await waitFor(() => expect(sent('POST', '/api/generate/recipes')).toEqual([{ fromId: 'quick', id: 'mine-2', name: 'Quick (copy)' }]));
    await waitFor(() => expect(screen.getByLabelText('Recipe name')).toHaveValue('Quick (copy)'));
    expect(screen.getByLabelText('Recipe name')).toBeEnabled();
  });

  it('steps reorder with the arrows or by dragging, are added before the export and removed; saving sends the recipe', async () => {
    await open();
    expect(order()).toEqual(['author', 'render', 'export']);
    expect(save()).toBeDisabled();                                                     // nothing changed yet
    fireEvent.click(screen.getByRole('button', { name: 'Move 2. render up' }));
    expect(order()).toEqual(['render', 'author', 'export']);
    expect(screen.getByRole('button', { name: 'Move 1. render up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move 3. export down' })).toBeDisabled();

    const [first, second] = screen.getAllByRole('listitem');
    fireEvent.dragStart(second!);
    fireEvent.drop(first!);
    expect(order()).toEqual(['author', 'render', 'export']);
    fireEvent.drop(first!);                                                            // a drop with nothing dragged does nothing
    expect(order()).toEqual(['author', 'render', 'export']);

    fireEvent.change(screen.getByLabelText('Step to add'), { target: { value: 'author' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(order()).toEqual(['author', 'render', 'author', 'export']);
    fireEvent.change(screen.getByLabelText('Step to add'), { target: { value: 'export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(order()).toEqual(['author', 'render', 'author', 'export', 'export']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove 5. export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 3. author' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Mine v2' } });
    fireEvent.click(save());
    await waitFor(() => expect(sent('PUT', '/api/generate/recipes/mine')).toHaveLength(1));
    expect((sent('PUT', '/api/generate/recipes/mine')[0] as any).recipe).toMatchObject({ name: 'Mine v2', steps: [{ use: 'author' }, { use: 'render' }, { use: 'export' }] });
  });

  it('a step opens a form made from its schema; gate, when, id and your own prompt are set there', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit 1. author' }));
    fireEvent.change(screen.getByLabelText('repairRounds'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('require'), { target: { value: 'hero, title' } });
    fireEvent.change(screen.getByLabelText('Step id'), { target: { value: 'scenes' } });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'connection:vision' } });
    fireEvent.change(screen.getByLabelText('Prompt mode'), { target: { value: 'append' } });
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Pakai warna hangat' } });
    fireEvent.click(save());
    await waitFor(() => expect(sent('PUT', '/api/generate/recipes/mine')).toHaveLength(1));
    expect((sent('PUT', '/api/generate/recipes/mine')[0] as any).recipe.steps[0]).toEqual({
      use: 'author', id: 'scenes', when: 'connection:vision', with: { repairRounds: 2, require: ['hero', 'title'] }, prompt: { mode: 'append', text: 'Pakai warna hangat' },
    });
    fireEvent.change(screen.getByLabelText('Prompt mode'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('repairRounds'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('require'), { target: { value: ' ' } });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close 1. scenes' }));
    expect(screen.getByRole('button', { name: 'Edit 1. scenes' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit 3. export' }));
    fireEvent.change(screen.getByLabelText('Gate'), { target: { value: 'owner' } });
    expect(screen.getByText('gate: owner')).toBeInTheDocument();
  });

  it('the validator\'s errors and warnings show as you type, and block saving', async () => {
    state.genValidation = { ok: false, errors: ['step "render" (#2): needs author before it'], warnings: ['creative: no criteria'] };
    await open();
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'x' } });
    expect(await screen.findByText(/needs author before it/)).toBeInTheDocument();
    expect(screen.getByText(/no criteria/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('the JSON tab is the same recipe as text: edits count, a half-typed one is ignored until it parses', async () => {
    await open();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const text = screen.getByLabelText('Recipe JSON') as HTMLTextAreaElement;
    expect(JSON.parse(text.value).id).toBe('mine');
    fireEvent.change(text, { target: { value: '{ "id": ' } });
    expect(save()).toBeDisabled();
    fireEvent.change(text, { target: { value: JSON.stringify({ ...makeGenRecipe('mine').recipe, name: 'From JSON' }) } });
    fireEvent.click(save());
    await waitFor(() => expect(sent('PUT', '/api/generate/recipes/mine')).toHaveLength(1));
    expect((sent('PUT', '/api/generate/recipes/mine')[0] as any).recipe.name).toBe('From JSON');
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    expect(screen.getByLabelText('Recipe name')).toHaveValue('From JSON');
  });

  it('shared rules are edited in place; a recipe can be exported, imported and deleted; failures are shown', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Defaults to look for (comma separated)'), { target: { value: 'gradient, glow' } });
    fireEvent.change(screen.getByLabelText('Smallest text (px)'), { target: { value: '40' } });
    fireEvent.click(save());
    await waitFor(() => expect(sent('PUT', '/api/generate/recipes/mine')).toHaveLength(1));
    expect((sent('PUT', '/api/generate/recipes/mine')[0] as any).recipe.rules).toEqual({ defaultsAudit: ['gradient', 'glow'], readability: { minTextPx: 40 } });
    fireEvent.change(screen.getByLabelText('Smallest text (px)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Defaults to look for (comma separated)'), { target: { value: '' } });

    expect(screen.getByRole('link', { name: 'Export' })).toHaveAttribute('href', '/api/generate/recipes/mine/export');
    jest.spyOn(window, 'prompt').mockReturnValue(JSON.stringify({ ...makeGenRecipe('shared').recipe }));
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await waitFor(() => expect(screen.getByLabelText('Recipe name')).toHaveValue('shared'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent('DELETE', '/api/generate/recipes/shared')).toHaveLength(1));

    jest.spyOn(window, 'prompt').mockReturnValue('{ not json');
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    jest.spyOn(window, 'prompt').mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to edit' }));
  });

  it('an unavailable recipe says why', async () => {
    state.genRecipes = [{ ...makeGenRecipe('quick', true), available: false, reasons: ['look: needs a vision-capable model in Settings'] }];
    render(<RecipeEditor api={api} />);
    expect(await screen.findByText(/Can't run here: look: needs a vision-capable model/)).toBeInTheDocument();
  });
});

describe('FieldInput', () => {
  const Probe = ({ f, initial }: { f: Parameters<typeof FieldInput>[0]['f']; initial?: unknown }) => {
    const [v, setV] = useState(initial);
    return <><FieldInput name="x" f={f} value={v} onChange={setV} /><output>{JSON.stringify(v ?? null)}</output></>;
  };
  it('draws every kind of field and writes back the right value', () => {
    render(<Probe f={{ t: 'bool' }} />);
    fireEvent.click(screen.getByLabelText('x'));
    expect(screen.getByText('true')).toBeInTheDocument();
  });

  it('lists add, edit and remove items; objects nest; a flag opens its own settings', () => {
    render(<Probe f={{ t: 'list', max: 2, item: { t: 'obj', fields: { id: { t: 'str', max: 10 } } } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add x' }));
    fireEvent.change(screen.getByLabelText('x 1.id'), { target: { value: 'hook' } });
    expect(screen.getByText('[{"id":"hook"}]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add x' }));
    expect(screen.getByRole('button', { name: 'Add x' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove x 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove x 1' }));
    expect(screen.getByText('[]')).toBeInTheDocument();
  });

  it('an always-on flag starts on; a plain one toggles', () => {
    render(<Probe f={{ t: 'flag', always: true }} initial={true} />);
    expect(screen.getByLabelText('x')).toBeChecked();
    fireEvent.click(screen.getByLabelText('x'));
    expect(screen.getByText('null')).toBeInTheDocument();      // never false: it can't be turned off
  });

  it('a flag with settings shows them once on, and writes them as an object', () => {
    render(<Probe f={{ t: 'flag', fields: { n: { t: 'num', min: 0, max: 5 } } }} />);
    fireEvent.click(screen.getByLabelText('x'));
    fireEvent.change(screen.getByLabelText('x.n'), { target: { value: '2.5' } });
    expect(screen.getByText('{"n":2.5}')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('x.n'), { target: { value: '' } });
    expect(screen.getByText('true')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('x'));
    expect(screen.getByText('false')).toBeInTheDocument();
  });

  it('an enum offers its values; objects with nothing set become unset', () => {
    render(<Probe f={{ t: 'obj', fields: { q: { t: 'enum', values: ['a', 'b'] } } }} />);
    fireEvent.change(screen.getByLabelText('x.q'), { target: { value: 'b' } });
    expect(screen.getByText('{"q":"b"}')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('x.q'), { target: { value: '' } });
    expect(screen.getByText('null')).toBeInTheDocument();
  });
});

describe('GenerateWindow: recipes', () => {
  it('the Recipes link opens the editor and back; recipes that can run are offered for a new video', async () => {
    state.generate = { ...state.generate };
    state.genRecipes = [makeGenRecipe('quick', true), makeGenRecipe('mine')];
    render(<GenerateWindow api={api} onOpenSettings={jest.fn()} pollMs={5} />);
    await screen.findByTestId('generate-ready');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Recipe' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Recipes' }));
    expect(await screen.findByLabelText('Recipe name')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← Back to videos' }));
    await screen.findByTestId('generate-ready');
  });
});
