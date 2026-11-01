'use client';

// The Recipes window: your own pipeline, without code. Pick a recipe (examples are copied, never
// edited), then add, remove and reorder its steps, set each step from the form its schema
// generates, choose gates, and see the validator's errors and warnings as you type. The JSON tab
// is the same recipe as text, for sharing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { GenField, GenRecipe, GenRecipeItem, GenRecipeStep, GenStepSpec } from '@/types';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';
const GATES = ['none', 'owner', 'director'];
const WHEN = ['', 'connection:image', 'connection:vision', 'connection:voice', 'connection:llm', 'connection:jev'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An empty value of this field, for a new list item. */
function blank(f: GenField): unknown {
  if (f.t === 'obj') return {};
  if (f.t === 'bool') return false;
  if (f.t === 'int' || f.t === 'num') return f.min;
  if (f.t === 'enum') return f.values[0];
  if (f.t === 'strs' || f.t === 'list') return [];
  return '';
}

/** Setting editor for one schema field, generated from the schema (recursive for objects and lists). */
export function FieldInput({ name, f, value, onChange }: { name: string; f: GenField; value: unknown; onChange: (v: unknown) => void }) {
  const set = (v: unknown) => onChange(v === '' ? undefined : v);
  switch (f.t) {
    case 'bool':
      return <label className="text-sm block"><input type="checkbox" aria-label={name} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {name}</label>;
    case 'int':
    case 'num':
      return (
        <label className="block"><span className={label}>{name} ({f.min} to {f.max})</span>
          <input aria-label={name} type="number" step={f.t === 'int' ? 1 : 'any'} value={typeof value === 'number' ? value : ''} className={field}
            onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} /></label>
      );
    case 'enum':
      return (
        <label className="block"><span className={label}>{name}</span>
          <select aria-label={name} value={typeof value === 'string' ? value : ''} className={field} onChange={(e) => set(e.target.value)}>
            <option value="">(default)</option>
            {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
          </select></label>
      );
    case 'str':
      return (
        <label className="block"><span className={label}>{name}</span>
          <input aria-label={name} value={typeof value === 'string' ? value : ''} maxLength={f.max} className={field} onChange={(e) => set(e.target.value)} /></label>
      );
    case 'strs':
      return (
        <label className="block"><span className={label}>{name} (comma separated)</span>
          <input aria-label={name} value={Array.isArray(value) ? value.join(', ') : ''} className={field}
            onChange={(e) => set(e.target.value.trim() ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : '')} /></label>
      );
    case 'flag': {
      const on = value === true || isObj(value);
      return (
        <fieldset className="border-2 border-line p-2">
          <label className="text-sm"><input type="checkbox" aria-label={name} checked={on} disabled={f.always && on && false} onChange={(e) => onChange(e.target.checked ? true : f.always ? undefined : false)} /> {name}{f.always ? ' (always on)' : ''}</label>
          {f.fields && on && <ObjectFields fields={f.fields} value={isObj(value) ? value : {}} onChange={(o) => onChange(Object.keys(o).length ? o : true)} prefix={name} />}
        </fieldset>
      );
    }
    case 'obj':
      return (
        <fieldset className="border-2 border-line p-2"><legend className={label}>{name}</legend>
          <ObjectFields fields={f.fields} value={isObj(value) ? value : {}} onChange={(o) => onChange(Object.keys(o).length ? o : undefined)} prefix={name} /></fieldset>
      );
    case 'list': {
      const items = Array.isArray(value) ? value : [];
      return (
        <fieldset className="border-2 border-line p-2"><legend className={label}>{name} (up to {f.max})</legend>
          {items.map((item, i) => (
            <div key={i} className="mb-2 border-b-2 border-line pb-2">
              <FieldInput name={`${name} ${i + 1}`} f={f.item} value={item} onChange={(v) => onChange(items.map((x, k) => (k === i ? v : x)))} />
              <button className="btn" aria-label={`Remove ${name} ${i + 1}`} onClick={() => onChange(items.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
          <button className="btn" disabled={items.length >= f.max} onClick={() => onChange([...items, blank(f.item)])}>Add {name}</button>
        </fieldset>
      );
    }
  }
}

function ObjectFields({ fields, value, onChange, prefix }: { fields: Record<string, GenField>; value: Obj; onChange: (o: Obj) => void; prefix: string }) {
  return (
    <div className="grid gap-2">
      {Object.entries(fields).map(([key, f]) => (
        <FieldInput key={key} name={prefix ? `${prefix}.${key}` : key} f={f} value={value[key]}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[key]; else next[key] = v;
            onChange(next);
          }} />
      ))}
    </div>
  );
}

function StepCard({ step, index, spec, count, onChange, onMove, onRemove, drag }: {
  step: GenRecipeStep; index: number; spec: GenStepSpec | undefined; count: number;
  onChange: (s: GenRecipeStep) => void; onMove: (to: number) => void; onRemove: () => void;
  drag: { onDragStart: () => void; onDrop: () => void };
}) {
  const [open, setOpen] = useState(false);
  const title = `${index + 1}. ${step.id ?? step.use}`;
  return (
    <li className="border-3 border-line bg-surface p-2" draggable onDragStart={drag.onDragStart} onDragOver={(e) => e.preventDefault()} onDrop={drag.onDrop}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sm">{title}</b>{step.id && <span className="text-xs text-subtle">({step.use})</span>}
        {step.gate && step.gate !== 'none' && <span className="text-xs border-2 border-line px-1">gate: {step.gate}</span>}
        <span className="ml-auto flex gap-1">
          <button className="btn" aria-label={`Move ${title} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>↑</button>
          <button className="btn" aria-label={`Move ${title} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>↓</button>
          <button className="btn" onClick={() => setOpen(!open)} aria-label={`${open ? 'Close' : 'Edit'} ${title}`}>{open ? 'Close' : 'Edit'}</button>
          <button className="btn" aria-label={`Remove ${title}`} onClick={onRemove}>✕</button>
        </span>
      </div>
      {open && spec && (
        <div className="grid gap-2 mt-2">
          <label className="block"><span className={label}>Id (optional, to use a step twice)</span>
            <input aria-label="Step id" value={step.id ?? ''} className={field} onChange={(e) => onChange({ ...step, id: e.target.value || undefined })} /></label>
          <label className="block"><span className={label}>Gate</span>
            <select aria-label="Gate" value={step.gate ?? spec.gates[0]} className={field} onChange={(e) => onChange({ ...step, gate: e.target.value as GenRecipeStep['gate'] })}>
              {GATES.filter((g) => (spec.gates as string[]).includes(g)).map((g) => <option key={g} value={g}>{g}</option>)}
            </select></label>
          <label className="block"><span className={label}>Only when</span>
            <select aria-label="When" value={step.when ?? ''} className={field} onChange={(e) => onChange({ ...step, when: e.target.value || undefined })}>
              {WHEN.map((w) => <option key={w} value={w}>{w || 'always'}</option>)}
            </select></label>
          <ObjectFields fields={spec.fields} value={step.with ?? {}} prefix="" onChange={(o) => onChange({ ...step, with: Object.keys(o).length ? o : undefined })} />
          <fieldset className="border-2 border-line p-2"><legend className={label}>Your own instructions for the director</legend>
            <select aria-label="Prompt mode" value={step.prompt?.mode ?? ''} className={field}
              onChange={(e) => onChange({ ...step, prompt: e.target.value ? { mode: e.target.value as 'append' | 'replace', text: step.prompt?.text ?? '' } : undefined })}>
              <option value="">none</option><option value="append">add to the built-in prompt</option><option value="replace">replace it</option>
            </select>
            {step.prompt && <textarea aria-label="Prompt text" rows={3} maxLength={4000} value={step.prompt.text} className={`${field} mt-1`}
              onChange={(e) => onChange({ ...step, prompt: { mode: step.prompt!.mode, text: e.target.value } })} />}
          </fieldset>
        </div>
      )}
    </li>
  );
}

export function RecipeEditor({ api }: { api: ApiClient }) {
  const [recipes, setRecipes] = useState<GenRecipeItem[]>([]);
  const [library, setLibrary] = useState<GenStepSpec[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<GenRecipe | null>(null);
  const [tab, setTab] = useState<'steps' | 'json'>('steps');
  const [jsonText, setJsonText] = useState('');
  const [problems, setProblems] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('author');
  const dragFrom = useRef<number | null>(null);

  const refresh = useCallback(async (pick?: string) => {
    const { recipes: list } = await api.listGenerateRecipes();
    setRecipes(list);
    const id = pick ?? selected ?? list[0]?.id ?? null;
    setSelected(id);
    setDraft(list.find((r) => r.id === id)?.recipe ?? null);
  }, [api, selected]);

  useEffect(() => {
    Promise.all([api.getGenerateSteps(), refresh()]).then(([s]) => setLibrary(s.steps), (e) => setError((e as Error).message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const current = recipes.find((r) => r.id === selected);
  const builtIn = !!current?.builtIn;
  useEffect(() => { if (draft) setJsonText(JSON.stringify(draft, null, 2)); }, [draft]);
  useEffect(() => {
    if (!draft) return;
    let live = true;
    api.validateGenerateRecipe(draft).then((r) => { if (live) setProblems(r); }, () => {});
    return () => { live = false; };
  }, [api, draft]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const specOf = useMemo(() => new Map(library.map((s) => [s.type, s])), [library]);
  const steps = draft?.steps ?? [];
  const setSteps = (next: GenRecipeStep[]) => setDraft(draft ? { ...draft, steps: next } : draft);
  const move = (from: number, to: number) => {
    const next = [...steps];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setSteps(next);
  };
  const dirty = !!draft && !!current && JSON.stringify(draft) !== JSON.stringify(current.recipe);

  const copy = () => run(async () => {
    const id = window.prompt('Id for your copy (lowercase letters, digits, dashes)', `${selected}-copy`);
    if (!id) return;
    const { recipe } = await api.copyGenerateRecipe(selected!, id, `${current?.name} (copy)`);
    await refresh(recipe.id);
  });
  const save = () => run(async () => {
    const parsed = tab === 'json' ? (JSON.parse(jsonText) as GenRecipe) : draft!;
    await api.saveGenerateRecipe(selected!, parsed);
    await refresh(selected!);
  });
  const remove = () => run(async () => {
    await api.deleteGenerateRecipe(selected!);
    await refresh(undefined);
  });
  const importText = () => run(async () => {
    const text = window.prompt('Paste a shared recipe (JSON)');
    if (!text) return;
    const { recipe } = await api.importGenerateRecipe(JSON.parse(text) as GenRecipe);
    await refresh(recipe.id);
  });

  return (
    <section aria-label="Recipes" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Recipe" value={selected ?? ''} className="field px-2 py-1.5" onChange={(e) => { setSelected(e.target.value); setDraft(recipes.find((r) => r.id === e.target.value)?.recipe ?? null); }}>
          {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.builtIn ? ' (example)' : ''}{r.available ? '' : ' — unavailable'}</option>)}
        </select>
        <button className="btn" disabled={!selected} onClick={copy}>Copy to edit</button>
        <button className="btn" onClick={importText}>Import…</button>
        {selected && <a className="btn" href={api.generateRecipeExportUrl(selected)} download>Export</a>}
        <button className="btn" disabled={builtIn || !selected} onClick={remove}>Delete</button>
      </div>
      {current && !current.available && <p className="text-xs text-warning">Can&apos;t run here: {current.reasons.join('; ')}</p>}
      {builtIn && <p className="text-xs text-subtle">An example: copy it to change it.</p>}
      {error && <p role="alert" className="text-error text-sm">{error}</p>}

      {draft && (
        <>
          <div className="flex gap-2" role="tablist">
            {(['steps', 'json'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>{t === 'steps' ? 'Steps' : 'JSON'}</button>)}
          </div>
          {tab === 'steps' ? (
            <fieldset disabled={builtIn} className="grid gap-2 min-w-0">
              <label className="block"><span className={label}>Name</span>
                <input aria-label="Recipe name" value={draft.name} className={field} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <ul className="grid gap-2">
                {steps.map((s, i) => (
                  <StepCard key={i} step={s} index={i} spec={specOf.get(s.use)} count={steps.length}
                    onChange={(n) => setSteps(steps.map((x, k) => (k === i ? n : x)))} onMove={(to) => move(i, to)} onRemove={() => setSteps(steps.filter((_, k) => k !== i))}
                    drag={{ onDragStart: () => { dragFrom.current = i; }, onDrop: () => { if (dragFrom.current !== null && dragFrom.current !== i) move(dragFrom.current, i); dragFrom.current = null; } }} />
                ))}
              </ul>
              <div className="flex gap-2">
                <select aria-label="Step to add" value={adding} className="field px-2 py-1.5" onChange={(e) => setAdding(e.target.value)}>
                  {library.map((s) => <option key={s.type} value={s.type}>{s.type}</option>)}
                </select>
                <button className="btn" onClick={() => {
                  const fresh = { use: adding } as GenRecipeStep;
                  const lastIsExport = steps.at(-1)?.use === 'export' && adding !== 'export';   // export must stay last
                  setSteps(lastIsExport ? [...steps.slice(0, -1), fresh, steps.at(-1)!] : [...steps, fresh]);
                }}>Add step</button>
              </div>
              <ShortcutRules draft={draft} onChange={setDraft} />
            </fieldset>
          ) : (
            <textarea aria-label="Recipe JSON" rows={18} value={jsonText} readOnly={builtIn} className={`${field} font-mono text-xs`}
              onChange={(e) => { setJsonText(e.target.value); try { setDraft(JSON.parse(e.target.value) as GenRecipe); } catch { /* typing: keep the last good recipe */ } }} />
          )}
          {problems.errors.map((m) => <p key={m} role="alert" className="text-xs text-error">✗ {m}</p>)}
          {problems.warnings.map((m) => <p key={m} className="text-xs text-warning">⚠ {m}</p>)}
          <button className="btn btn-primary" disabled={builtIn || !dirty || problems.errors.length > 0} onClick={save}>Save recipe</button>
        </>
      )}
    </section>
  );
}

/** The shared rules every step reads: the readability floor and the audit list. */
function ShortcutRules({ draft, onChange }: { draft: GenRecipe; onChange: (r: GenRecipe) => void }) {
  const rules = (draft.rules ?? {}) as Obj;
  const audit = Array.isArray(rules.defaultsAudit) ? (rules.defaultsAudit as string[]) : [];
  const set = (key: string, v: unknown) => {
    const next = { ...rules };
    if (v === undefined) delete next[key]; else next[key] = v;
    onChange({ ...draft, rules: Object.keys(next).length ? next : undefined });
  };
  return (
    <fieldset className="border-2 border-line p-2"><legend className={label}>Shared rules</legend>
      <FieldInput name="Defaults to look for (comma separated)" f={{ t: 'strs', maxItems: 20 }} value={audit} onChange={(v) => set('defaultsAudit', v)} />
      <FieldInput name="Smallest text (px)" f={{ t: 'int', min: 8, max: 400 }} value={(rules.readability as Obj | undefined)?.minTextPx}
        onChange={(v) => set('readability', v === undefined ? undefined : { ...((rules.readability as Obj) ?? {}), minTextPx: v })} />
    </fieldset>
  );
}
