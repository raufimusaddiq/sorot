'use client';

// Settings → Generate: the connections only Generate uses. The narration voice (one engine and a
// voice per language), the image service for scene pictures, and the local commands recipes may
// name. Keys are never shown back; a recipe that needs one of these is unavailable until it is set.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { ConnectionKind, ConnectionTest, Connections, GenCommand, GenLevel, GenModels, KenariModel, KenariVoiceModel } from '@/types';
import { KitPanel } from './generate/KitPanel';
import { Toggle } from './ImportOptions';
import { Window } from './Window';

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

// Kenari (kenari.id): this project's default AI provider, also offering an OpenAI-compatible
// image endpoint and text-to-speech — both already work through the generic fields below with
// no protocol change; these pickers just make picking a Kenari model/voice a live choice instead
// of something to type by hand.
const KENARI_BASE_URL = 'https://kenari.id/v1';
const KENARI_DEFAULT_IMAGE_MODEL = 'gpt-image-2';

function connectionMode(baseUrl: string | undefined): 'unset' | 'kenari' | 'custom' {
  if (!baseUrl) return 'unset';
  return baseUrl === KENARI_BASE_URL ? 'kenari' : 'custom';
}
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

  // Kenari also speaks the openai engine's exact /audio/speech shape — only relevant while that
  // engine is picked; any other engine (elevenlabs, fish, local) keeps its own fields unchanged.
  const [mode, setMode] = useState<'kenari' | 'custom' | null>(null);
  const [kenariModels, setKenariModels] = useState<KenariVoiceModel[]>([]);
  const [kenariModel, setKenariModel] = useState('');
  useEffect(() => {
    if (view.engine !== 'openai') { setMode(null); return; }
    const m = connectionMode(view.baseUrl);
    setMode(m === 'unset' ? null : m);
  }, [view.engine, view.baseUrl]);
  useEffect(() => {
    if (view.engine === 'openai' && mode === 'kenari' && kenariModels.length === 0) {
      api.getKenariVoiceModels().then((r) => {
        setKenariModels(r.models);
        if (r.models[0]) setKenariModel((cur) => cur || r.models[0]!.id);
      }, () => setKenariModels([]));
    }
  }, [view.engine, mode, kenariModels.length, api]);
  const kenari = view.engine === 'openai' && mode === 'kenari';
  const kenariVoices = kenariModels.find((m) => m.id === kenariModel)?.voices ?? [];

  const patch = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    if (kenari) {
      if (view.baseUrl !== KENARI_BASE_URL) p.baseUrl = KENARI_BASE_URL;
      if (kenariModel && view.model !== kenariModel) p.model = kenariModel;
    } else {
      for (const k of ['baseUrl', 'model'] as const) if (form[k] !== undefined && form[k] !== (view[k] ?? '')) p[k] = form[k];
    }
    if (Object.keys(voices).length) p.voices = Object.fromEntries(LANGUAGES.map(([c]) => [c, voiceOf(c)]).filter(([, v]) => v));
    if (key.trim()) p.apiKey = key.trim();
    return p;
  };
  const clear = () => { setForm({}); setVoices({}); setKey(''); };
  const dirty = Object.keys(patch()).length > 0;
  const switchMode = (m: 'kenari' | 'custom') => { setMode(m); setForm({}); setVoices({}); setKey(''); };

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
        {view.engine === 'openai' && mode === null && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => switchMode('kenari')}>Connect Kenari</button>
            <button className="btn" onClick={() => switchMode('custom')}>Use a different endpoint</button>
          </div>
        )}
        {view.engine === 'openai' && mode !== null && (
          <button className="text-xs text-subtle underline -mt-1 text-left" onClick={() => switchMode(kenari ? 'custom' : 'kenari')}>
            {kenari ? 'Use a different endpoint instead' : 'Use Kenari instead'}
          </button>
        )}
        {view.engine !== 'local' && !kenari && (view.engine !== 'openai' || mode !== null) && (
          <>
            <label>
              <span className={label}>Base URL (optional for ElevenLabs and Fish)</span>
              <input aria-label="Voice base URL" value={value('baseUrl')} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className={field} />
            </label>
            <label>
              <span className={label}>Model (optional)</span>
              <input aria-label="Voice model" value={value('model')} onChange={(e) => setForm({ ...form, model: e.target.value })} className={field} />
            </label>
          </>
        )}
        {kenari && (
          <label>
            <span className={label}>Model</span>
            <select aria-label="Kenari voice model" className={field} value={kenariModel} onChange={(e) => { setKenariModel(e.target.value); setVoices({}); }}>
              {kenariModels.length === 0 && <option value="">(loading…)</option>}
              {kenariModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </label>
        )}
        {view.engine !== 'local' && (view.engine !== 'openai' || mode !== null) && (
          <label>
            <span className={label}>API key</span>
            <input aria-label="Voice API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={field}
              placeholder={view.apiKeySet ? `${view.apiKey} (leave empty to keep)` : 'not set'} />
          </label>
        )}
        {view.engine === 'local' && (
          <p className="text-xs text-subtle" role="note">
            KittenTTS speaks English with a built-in voice (Bruno unless you name another). It has no Indonesian voice: for Indonesian, put the path of a 5 to 30 s recording of one speaker in the field below and it is cloned, or use an online engine.
          </p>
        )}
        {(view.engine !== 'openai' || mode !== null) && LANGUAGES.map(([code, name]) => (
          <label key={code}>
            <span className={label}>Voice for {name}</span>
            {kenari && kenariVoices.length > 0 ? (
              <select aria-label={`Voice for ${name}`} className={field} value={voiceOf(code)} onChange={(e) => setVoices({ ...voices, [code]: e.target.value })}>
                <option value="">(model default)</option>
                {kenariVoices.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <input aria-label={`Voice for ${name}`} value={voiceOf(code)} placeholder="voice id" onChange={(e) => setVoices({ ...voices, [code]: e.target.value })} className={field} />
            )}
          </label>
        ))}
      </div>
      {(view.engine !== 'openai' || mode !== null) && (
        <div className="flex flex-wrap gap-2 mt-4">
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => save(patch()).then(clear)}>Save</button>
          <button className="btn" disabled={busy} onClick={runTest}>Test</button>
        </div>
      )}
      <Result error={error} test={test} />
    </Window>
  );
}

function ImageCard({ api, view, onSaved }: { api: ApiClient; view: NonNullable<Connections['image']>; onSaved: (c: Connections) => void }) {
  const { busy, error, test, save, runTest } = useCard('image', api, onSaved);
  const [form, setForm] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [mode, setMode] = useState<'kenari' | 'custom' | null>(() => {
    const m = connectionMode(view.baseUrl);
    return m === 'unset' ? null : m;
  });
  const [kenariModels, setKenariModels] = useState<KenariModel[]>([]);
  const [kenariModel, setKenariModel] = useState(KENARI_DEFAULT_IMAGE_MODEL);
  const fields = [['baseUrl', 'Base URL', 'https://…/v1'], ['model', 'Model', 'flux-1'], ['size', 'Size', '1024x1792'], ['style', 'House style (optional)', 'flat, warm colours']] as const;
  const kenari = mode === 'kenari';

  useEffect(() => {
    if (kenari && kenariModels.length === 0) api.getKenariImageModels().then((r) => setKenariModels(r.models), () => setKenariModels([]));
  }, [kenari, kenariModels.length, api]);

  const patch = () => {
    const p: Record<string, string> = {};
    if (kenari) {
      if (view.baseUrl !== KENARI_BASE_URL) p.baseUrl = KENARI_BASE_URL;
      if (view.model !== kenariModel) p.model = kenariModel;
      for (const k of ['size', 'style'] as const) if (form[k] !== undefined && form[k] !== (view[k] ?? '')) p[k] = form[k]!;
    } else {
      for (const [k] of fields) if (form[k] !== undefined && form[k] !== (view[k] ?? '')) p[k] = form[k]!;
    }
    if (key.trim()) p.apiKey = key.trim();
    return p;
  };
  const switchMode = (m: 'kenari' | 'custom') => { setMode(m); setForm({}); setKey(''); };
  const dirty = Object.keys(patch()).length > 0;

  return (
    <Window title="Scene images" bar="bg-lilac" right={view.active ? 'active' : 'off'}>
      <p className="text-sm text-fg/80 mb-1">Any OpenAI-compatible <code>/images/generations</code> service, Kenari included. A shot that asks for a picture gets one; without this its fallback visual is drawn.</p>
      {mode === null && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button className="btn btn-primary" onClick={() => switchMode('kenari')}>Connect Kenari</button>
          <button className="btn" onClick={() => switchMode('custom')}>Use a different service</button>
        </div>
      )}
      {mode !== null && (
        <button className="text-xs text-subtle underline mt-2" onClick={() => switchMode(kenari ? 'custom' : 'kenari')}>
          {kenari ? 'Use a different service instead' : 'Use Kenari instead'}
        </button>
      )}
      {mode !== null && (
        <div className="grid gap-3 mt-3">
          <Toggle checked={view.enabled} onChange={(v) => save({ enabled: v })}><span>Use images</span></Toggle>
          {kenari ? (
            <>
              <label>
                <span className={label}>Model</span>
                <select aria-label="Kenari image model" className={field} value={kenariModel} onChange={(e) => setKenariModel(e.target.value)}>
                  <option value={KENARI_DEFAULT_IMAGE_MODEL}>{KENARI_DEFAULT_IMAGE_MODEL}</option>
                  {kenariModels.filter((m) => m.id !== KENARI_DEFAULT_IMAGE_MODEL).map((m) => (
                    <option key={m.id} value={m.id}>{m.id}{m.free ? ' (free)' : ''}</option>
                  ))}
                </select>
              </label>
              {(['size', 'style'] as const).map((k) => {
                const [, name, placeholder] = fields.find(([fk]) => fk === k)!;
                return (
                  <label key={k}>
                    <span className={label}>{name}</span>
                    <input aria-label={`Image ${name}`} value={form[k] ?? view[k] ?? ''} placeholder={placeholder} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={field} />
                  </label>
                );
              })}
            </>
          ) : (
            fields.map(([k, name, placeholder]) => (
              <label key={k}>
                <span className={label}>{name}</span>
                <input aria-label={`Image ${name}`} value={form[k] ?? view[k] ?? ''} placeholder={placeholder} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={field} />
              </label>
            ))
          )}
          <label>
            <span className={label}>API key</span>
            <input aria-label="Image API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={field}
              placeholder={view.apiKeySet ? `${view.apiKey} (leave empty to keep)` : 'not set'} />
          </label>
        </div>
      )}
      {mode !== null && (
        <div className="flex flex-wrap gap-2 mt-4">
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => save(patch()).then(() => { setForm({}); setKey(''); })}>Save</button>
          <button className="btn" disabled={busy} onClick={runTest}>Test</button>
        </div>
      )}
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
      <p className="text-sm text-fg/80 mb-2">Every shot starts with the director free to draw anything; a shot that fails falls back to kit parts. The record and Calibrate show how a model fares, so you can pin a weak one lower.</p>
      {data?.models.map((m) => (
        <div key={m.model} aria-label={`Model ${m.model}`} className="border-2 border-line p-2 mb-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <b>{m.model}</b>
            <label className="ml-auto text-xs flex items-center gap-1">
              level
              <select aria-label={`${m.model} level`} disabled={busy} value={m.pin ?? 'auto'} onChange={(e) => act(() => api.pinModel(m.model, e.target.value === 'auto' ? null : (e.target.value as GenLevel)))} className="field px-1 py-0.5">
                <option value="auto">auto (starts at {m.auto}{m.proven ? `, proven ${m.proven}` : ''})</option>
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
