'use client';

// Settings → Generate: the connections only Generate uses. The narration voice (one engine and a
// voice per language), the image service for scene pictures, and the local commands recipes may
// name. Keys are never shown back; a recipe that needs one of these is unavailable until it is set.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { ConnectionKind, ConnectionTest, Connections, GenCommand, GenLevel, GenModels } from '@/types';
import { KitPanel } from './generate/KitPanel';
import { Toggle } from './ImportOptions';
import { Window } from './Window';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';
const ENGINE_NOTE: Record<string, string> = {
  elevenlabs: 'ElevenLabs (word times come with the voice)', fish: 'Fish Audio', openai: 'OpenAI-compatible /audio/speech', local: 'Local KittenTTS, on this GPU',
};
const LANGUAGES: Array<[code: string, name: string]> = [['id', 'Indonesian'], ['en', 'English']];

/** Save + test + error + test result, shared by the three cards. */
function useCard(kind: ConnectionKind, api: ApiClient, onSaved: (c: Connections) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateSettings(kind, patch as Record<string, string | boolean | null>));
      setTest(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await api.testConnection(kind));
    } catch (e) {
      setTest({ ok: false, ms: 0, error: (e as Error).message });
    }
    setBusy(false);
  };
  return { busy, error, test, save, runTest };
}

function Result({ error, test }: { error: string | null; test: ConnectionTest | null }) {
  return (
    <>
      {error && <p role="alert" className="text-error text-sm mt-2">{error}</p>}
      {test && (
        <p className={`text-sm mt-2 ${test.ok ? 'text-success' : 'text-error'}`}>
          {test.ok ? `OK in ${test.ms} ms${test.model ? ` · ${test.model}` : ''}${test.detail ? ` · ${test.detail}` : ''}` : `Failed: ${test.error}`}
        </p>
      )}
    </>
  );
}

function VoiceCard({ api, view, onSaved }: { api: ApiClient; view: NonNullable<Connections['voice']>; onSaved: (c: Connections) => void }) {
  const { busy, error, test, save, runTest } = useCard('voice', api, onSaved);
  const [form, setForm] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const value = (k: 'baseUrl' | 'model') => form[k] ?? view[k] ?? '';
  const voiceOf = (code: string) => voices[code] ?? view.voices[code] ?? '';

  const patch = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const k of ['baseUrl', 'model'] as const) if (form[k] !== undefined && form[k] !== (view[k] ?? '')) p[k] = form[k];
    if (Object.keys(voices).length) p.voices = Object.fromEntries(LANGUAGES.map(([c]) => [c, voiceOf(c)]).filter(([, v]) => v));
    if (key.trim()) p.apiKey = key.trim();
    return p;
  };
  const clear = () => { setForm({}); setVoices({}); setKey(''); };
  const dirty = Object.keys(patch()).length > 0;

  return (
    <Window title="Narration voice" bar="bg-sun" right={view.active ? 'active' : 'off'}>
      <p className="text-sm text-fg/80 mb-1">Speaks the script of a narrated video. One engine at a time; each language has its own voice.</p>
      {!view.active && <p className="text-xs text-subtle mb-3">No engine yet: videos can&apos;t be narrated, and recipes that need a voice are unavailable.</p>}
      <div className="grid gap-3 mt-3">
        <Toggle checked={view.enabled} onChange={(v) => save({ enabled: v })}><span>Use the voice</span></Toggle>
        <label>
          <span className={label}>Engine</span>
          <select aria-label="Voice engine" value={view.engine} disabled={busy} className={field} onChange={(e) => save({ engine: e.target.value })}>
            <option value="">(none)</option>
            {view.engines.map((e) => (
              <option key={e} value={e} disabled={e === 'local' && !view.localAvailable}>{ENGINE_NOTE[e] ?? e}{e === 'local' && !view.localAvailable ? ' — needs a GPU install' : ''}</option>
            ))}
          </select>
        </label>
        {view.engine !== 'local' && (
          <>
            <label>
              <span className={label}>Base URL (optional for ElevenLabs and Fish)</span>
              <input aria-label="Voice base URL" value={value('baseUrl')} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className={field} />
            </label>
            <label>
              <span className={label}>Model (optional)</span>
              <input aria-label="Voice model" value={value('model')} onChange={(e) => setForm({ ...form, model: e.target.value })} className={field} />
            </label>
            <label>
              <span className={label}>API key</span>
              <input aria-label="Voice API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={field}
                placeholder={view.apiKeySet ? `${view.apiKey} (leave empty to keep)` : 'not set'} />
            </label>
          </>
        )}
        {view.engine === 'local' && (
          <p className="text-xs text-subtle" role="note">
            KittenTTS speaks English with a built-in voice (Bruno unless you name another). It has no Indonesian voice: for Indonesian, put the path of a 5 to 30 s recording of one speaker in the field below and it is cloned, or use an online engine.
          </p>
        )}
        {LANGUAGES.map(([code, name]) => (
          <label key={code}>
            <span className={label}>Voice for {name}</span>
            <input aria-label={`Voice for ${name}`} value={voiceOf(code)} placeholder="voice id" onChange={(e) => setVoices({ ...voices, [code]: e.target.value })} className={field} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => save(patch()).then(clear)}>Save</button>
        <button className="btn" disabled={busy} onClick={runTest}>Test</button>
      </div>
      <Result error={error} test={test} />
    </Window>
  );
}

function ImageCard({ api, view, onSaved }: { api: ApiClient; view: NonNullable<Connections['image']>; onSaved: (c: Connections) => void }) {
  const { busy, error, test, save, runTest } = useCard('image', api, onSaved);
  const [form, setForm] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const fields = [['baseUrl', 'Base URL', 'https://…/v1'], ['model', 'Model', 'flux-1'], ['size', 'Size', '1024x1792'], ['style', 'House style (optional)', 'flat, warm colours']] as const;
  const patch = () => {
    const p: Record<string, string> = {};
    for (const [k] of fields) if (form[k] !== undefined && form[k] !== (view[k] ?? '')) p[k] = form[k]!;
    if (key.trim()) p.apiKey = key.trim();
    return p;
  };
  return (
    <Window title="Scene images" bar="bg-lilac" right={view.active ? 'active' : 'off'}>
      <p className="text-sm text-fg/80 mb-1">Any OpenAI-compatible <code>/images/generations</code> service. A shot that asks for a picture gets one; without this its fallback visual is drawn.</p>
      <div className="grid gap-3 mt-3">
        <Toggle checked={view.enabled} onChange={(v) => save({ enabled: v })}><span>Use images</span></Toggle>
        {fields.map(([k, name, placeholder]) => (
          <label key={k}>
            <span className={label}>{name}</span>
            <input aria-label={`Image ${name}`} value={form[k] ?? view[k] ?? ''} placeholder={placeholder} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={field} />
          </label>
        ))}
        <label>
          <span className={label}>API key</span>
          <input aria-label="Image API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={field}
            placeholder={view.apiKeySet ? `${view.apiKey} (leave empty to keep)` : 'not set'} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <button className="btn btn-primary" disabled={busy || Object.keys(patch()).length === 0} onClick={() => save(patch()).then(() => { setForm({}); setKey(''); })}>Save</button>
        <button className="btn" disabled={busy} onClick={runTest}>Test</button>
      </div>
      <Result error={error} test={test} />
    </Window>
  );
}

const blankCommand = (): GenCommand => ({ name: '', cmd: '', args: [], timeoutSec: 60 });

function CommandsCard({ api, view, onSaved }: { api: ApiClient; view: NonNullable<Connections['commands']>; onSaved: (c: Connections) => void }) {
  const { busy, error, test, save, runTest } = useCard('commands', api, onSaved);
  const [list, setList] = useState<GenCommand[] | null>(null);
  const commands = list ?? view.commands;
  const set = (i: number, c: Partial<GenCommand>) => setList(commands.map((x, k) => (k === i ? { ...x, ...c } : x)));
  return (
    <Window title="Custom commands" bar="bg-aqua" right={view.active ? `${view.commands.length} registered` : 'off'}>
      <p className="text-sm text-fg/80 mb-1">Your own checks. A recipe can name one of these; it is run on a build with <code>--project-dir</code> and <code>--version-dir</code> and prints its findings as JSON. A shared recipe can never add one.</p>
      {!view.allowed && <p role="status" className="text-xs text-warning mb-2">Custom commands are off on this install (the server&apos;s admin enables them).</p>}
      <fieldset disabled={!view.allowed || busy} className="grid gap-3 mt-3 min-w-0">
        {commands.map((c, i) => (
          <div key={i} className="border-2 border-line p-2 grid gap-2">
            <input aria-label={`Command ${i + 1} name`} value={c.name} placeholder="name (brand-check)" onChange={(e) => set(i, { name: e.target.value })} className={field} />
            <input aria-label={`Command ${i + 1} program`} value={c.cmd} placeholder="program (python)" onChange={(e) => set(i, { cmd: e.target.value })} className={field} />
            <input aria-label={`Command ${i + 1} arguments`} value={c.args.join(' ')} placeholder="arguments (check.py)" onChange={(e) => set(i, { args: e.target.value.split(/\s+/).filter(Boolean) })} className={field} />
            <input aria-label={`Command ${i + 1} time limit`} type="number" min={1} max={600} value={c.timeoutSec} onChange={(e) => set(i, { timeoutSec: Number(e.target.value) })} className={field} />
            <button className="btn" onClick={() => setList(commands.filter((_, k) => k !== i))}>Remove command {i + 1}</button>
          </div>
        ))}
        <button className="btn" onClick={() => setList([...commands, blankCommand()])}>Add a command</button>
      </fieldset>
      <div className="flex flex-wrap gap-2 mt-4">
        <button className="btn btn-primary" disabled={busy || !view.allowed || list === null} onClick={() => save({ commands }).then(() => setList(null))}>Save</button>
        <button className="btn" disabled={busy} onClick={runTest}>Test</button>
      </div>
      <Result error={error} test={test} />
    </Window>
  );
}

const LEVEL_NAMES: Record<string, string> = { kit: 'kit', compose: 'compose', free: 'free' };
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');

/**
 * How each model fares per level on this install, the level `auto` gives it, a pin, and Calibrate
 * (three sample shots at each level, a few minutes, with the connected model).
 */
export function ModelsCard({ api }: { api: ApiClient }) {
  const [data, setData] = useState<GenModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.generateModels().then(setData, (e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // while a calibration runs, look again every few seconds
  const running = !!data?.calibration && !data.calibration.done;
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const cal = data?.calibration;
  return (
    <Window title="Models" bar="bg-mint" right={data?.current || undefined}>
      <p className="text-sm text-fg/80 mb-2">A model starts by building shots from kit parts; once it passes its checks often enough it writes scenes itself. Calibrate measures it at once.</p>
      {data?.models.map((m) => (
        <div key={m.model} aria-label={`Model ${m.model}`} className="border-2 border-line p-2 mb-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <b>{m.model}</b>
            <label className="ml-auto text-xs flex items-center gap-1">
              level
              <select aria-label={`${m.model} level`} disabled={busy} value={m.pin ?? 'auto'} onChange={(e) => act(() => api.pinModel(m.model, e.target.value === 'auto' ? null : (e.target.value as GenLevel)))} className="field px-1 py-0.5">
                <option value="auto">auto ({m.auto})</option>
                {Object.keys(LEVEL_NAMES).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>
          {m.records.length > 0 && (
            <table className="text-xs mt-1 w-full">
              <thead><tr><th className="text-left">at</th><th>asked</th><th>first time</th><th>repaired</th><th>dropped</th><th>malformed</th></tr></thead>
              <tbody>
                {m.records.map((r) => (
                  <tr key={r.level}><td>{r.level}</td><td className="text-center">{r.asked}</td><td className="text-center">{pct(r.firstPass, r.asked)}</td><td className="text-center">{pct(r.repaired, r.asked)}</td><td className="text-center">{r.dropped}</td><td className="text-center">{r.malformed}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      <button className="btn" disabled={busy || running || !data?.current} onClick={() => act(() => api.calibrateModel())}>{running ? 'Calibrating…' : `Calibrate ${data?.current ?? ''}`.trim()}</button>
      {cal?.done && cal.result && (
        <p role="status" className="text-xs mt-2">
          Calibrated {cal.model}: {Object.entries(cal.result).map(([l, t]) => `${l} ${t!.firstPass + t!.repaired}/${t!.asked}`).join(' · ')}
        </p>
      )}
      {cal?.done && cal.error && <p role="alert" className="text-error text-sm mt-2">Calibration failed: {cal.error}</p>}
      {error && <p role="alert" className="text-error text-sm mt-2">{error}</p>}
    </Window>
  );
}

/** The Generate-only cards, shown when the server offers them. */
export function GenerateConnections({ api, conns, onSaved }: { api: ApiClient; conns: Connections; onSaved: (c: Connections) => void }) {
  if (!conns.voice && !conns.image && !conns.commands) return null;
  return (
    <section aria-label="Generate connections" className="mt-8">
      <h2 className="heading text-xl mb-3">Generate</h2>
      <div className="grid gap-6 lg:grid-cols-3">
        {conns.voice && <VoiceCard api={api} view={conns.voice} onSaved={onSaved} />}
        {conns.image && <ImageCard api={api} view={conns.image} onSaved={onSaved} />}
        {conns.commands && <CommandsCard api={api} view={conns.commands} onSaved={onSaved} />}
        <KitPanel api={api} />
        <ModelsCard api={api} />
      </div>
    </section>
  );
}
