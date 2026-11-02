'use client';

// Settings app: the LLM, Jev and Tebar connections. Saved in the app (they
// win over the server's .env); "Use .env" clears them. API keys are never
// shown back — only whether one is set and its last four characters.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';
import type { ConnectionTest, ConnectionView, Connections, KenariModel } from '@/types';
import { GenerateConnections } from './GenerateConnections';
import { Toggle } from './ImportOptions';
import { Window } from './Window';

type CoreKind = 'llm' | 'jev' | 'tebar';
type FieldDef = { key: 'baseUrl' | 'url' | 'model' | 'genMaxTokens'; label: string; placeholder: string };

// Kenari (kenari.id): this project's default AI provider — one API key, no endpoint to type.
// Still fully optional and swappable: "Use a different provider" reaches the same baseUrl/model
// fields this card has always had, untouched.
export const KENARI_BASE_URL = 'https://kenari.id/v1';
export const KENARI_DEFAULT_MODEL = 'kenari/auto';

/** Unset: nothing saved yet. Kenari: the saved baseUrl is Kenari's. Custom: anything else. */
export function connectionMode(baseUrl: string | undefined): 'unset' | 'kenari' | 'custom' {
  if (!baseUrl) return 'unset';
  return baseUrl === KENARI_BASE_URL ? 'kenari' : 'custom';
}

const CARDS: Record<CoreKind, { title: string; bar: string; about: string; fallback: string; fields: FieldDef[] }> = {
  llm: {
    title: 'LLM', bar: 'bg-lilac',
    about: 'Any OpenAI-compatible endpoint (Ollama, LM Studio, Groq, OpenRouter, OpenAI…). Reviews clips, writes copy and, as director, reads the whole video to pick moments and hooks.',
    fallback: 'Off: the rules find, score and title the clips.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'http://localhost:11434/v1' },
      { key: 'model', label: 'Model', placeholder: 'qwen2.5:7b' },
      // Generate writes whole scene files: a reasoning model needs far more than a clip review.
      { key: 'genMaxTokens', label: 'Generate token budget', placeholder: '32000' },
    ],
  },
  jev: {
    title: 'Jev quality gate', bar: 'bg-aqua',
    about: 'TypeSafe’s decision model answers fixed yes/no questions about each clip (hook, needs context, ending, filler, payoff, content risks) and checks the LLM’s titles and post copy. As director it also finds the moments, hook lines and quote titles in place of the LLM.',
    fallback: 'Off: the same questions are answered by text rules.',
    fields: [
      { key: 'url', label: 'Endpoint', placeholder: 'https://api.typesafe.ai/v1/systemone' },
      { key: 'model', label: 'Model', placeholder: 'jev-1.14.0' },
    ],
  },
  tebar: {
    title: 'Tebar publishing', bar: 'bg-mint',
    about: 'Posts clips to the TikTok, Instagram, YouTube, Threads… accounts you connected at tebar.app, and pulls their views and likes back so scoring learns from real results.',
    fallback: 'Off: download clips and post them yourself.',
    fields: [{ key: 'baseUrl', label: 'API base URL', placeholder: 'https://api.tebar.app/v1' }],
  },
};

const DIRECTOR = {
  llm: 'Director: read the whole video, pick moments and hooks (more LLM calls)',
  jev: 'Director: judge every moment, pick hooks and quote titles (wins over the LLM director)',
};

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

function ConnectionCard({ kind, view, api, onSaved }: {
  kind: CoreKind; view: ConnectionView; api: ApiClient; onSaved: (c: Connections) => void;
}) {
  const card = CARDS[kind];
  const [form, setForm] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  // llm only: which branch of the card is shown. null = not chosen yet (first run).
  const [mode, setMode] = useState<'kenari' | 'custom' | null>(() => {
    if (kind !== 'llm') return null;
    const m = connectionMode(view.baseUrl);
    return m === 'unset' ? null : m;
  });
  const [kenariModels, setKenariModels] = useState<KenariModel[]>([]);
  const [kenariModel, setKenariModel] = useState(KENARI_DEFAULT_MODEL);
  const [kenariProbe, setKenariProbe] = useState<ConnectionTest | null>(null);

  useEffect(() => {
    if (kind === 'llm' && mode === 'kenari' && kenariModels.length === 0) {
      api.getKenariModels().then((r) => setKenariModels(r.models), () => setKenariModels([]));
    }
  }, [kind, mode, kenariModels.length, api]);

  const value = (k: FieldDef['key']) => form[k] ?? String(view[k] ?? '');
  const patchOf = (): Record<string, string> => {
    const p: Record<string, string> = {};
    for (const f of card.fields) if (form[f.key] !== undefined && form[f.key] !== String(view[f.key] ?? '')) p[f.key] = form[f.key]!;
    if (key.trim()) p.apiKey = key.trim();
    return p;
  };

  const save = async (patch: Record<string, string | boolean | null>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateSettings(kind, patch));
      setForm({});
      setKey('');
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

  const probeKenari = async () => {
    setBusy(true);
    setKenariProbe(null);
    try {
      setKenariProbe(await api.probeLlm({ model: kenariModel, apiKey: key.trim() }));
    } catch (e) {
      setKenariProbe({ ok: false, ms: 0, error: (e as Error).message });
    }
    setBusy(false);
  };

  const dirty = Object.keys(patchOf()).length > 0;
  const kenari = kind === 'llm' && mode === 'kenari';
  const switchMode = (m: 'kenari' | 'custom') => {
    setMode(m);
    setForm({});
    setKey('');
    setError(null);
    setTest(null);
    setKenariProbe(null);
  };

  return (
    <Window title={card.title} bar={card.bar} right={view.active ? 'active' : 'off'}>
      <p className="text-sm text-fg/80 mb-1">{card.about}</p>
      {!view.active && <p className="text-xs text-subtle mb-3">{card.fallback}</p>}
      {kind === 'llm' && mode === null && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button className="btn btn-primary" onClick={() => switchMode('kenari')}>Connect Kenari</button>
          <button className="btn" onClick={() => switchMode('custom')}>Use a different provider</button>
        </div>
      )}
      {kind === 'llm' && mode !== null && (
        <button className="text-xs text-subtle underline mt-2" onClick={() => switchMode(mode === 'kenari' ? 'custom' : 'kenari')}>
          {mode === 'kenari' ? 'Use a different provider instead' : 'Use Kenari instead'}
        </button>
      )}
      {(kind !== 'llm' || mode !== null) && (
        <div className="grid gap-3 mt-3">
          <Toggle checked={view.enabled} onChange={(v) => save({ enabled: v })}>
            <span>Use {card.title}</span>
          </Toggle>
          {kind !== 'tebar' && (
            <Toggle checked={!!view.director} onChange={(v) => save({ director: v })}>
              <span>{DIRECTOR[kind]}</span>
            </Toggle>
          )}
          {kenari ? (
            <>
              <label>
                <span className={label}>Model</span>
                <select aria-label="Kenari model" className={field} value={kenariModel} onChange={(e) => setKenariModel(e.target.value)}>
                  <option value={KENARI_DEFAULT_MODEL}>kenari/auto (recommended — automatic routing)</option>
                  {kenariModels.filter((m) => m.id !== KENARI_DEFAULT_MODEL).map((m) => (
                    <option key={m.id} value={m.id}>{m.id}{m.free ? ' (free)' : ''}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className={label}>Kenari API key</span>
                <input aria-label="Kenari API key" type="password" autoComplete="off" value={key}
                  placeholder={view.apiKeySet && view.baseUrl === KENARI_BASE_URL ? `${view.apiKey} (leave empty to keep)` : 'kn-…'}
                  onChange={(e) => { setKey(e.target.value); setKenariProbe(null); }} className={field} />
              </label>
            </>
          ) : (
            <>
              {card.fields.map((f) => (
                <label key={f.key}>
                  <span className={label}>{f.label}</span>
                  <input aria-label={`${card.title} ${f.label}`} value={value(f.key)} placeholder={f.placeholder}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className={field} />
                </label>
              ))}
              <label>
                <span className={label}>API key</span>
                <input aria-label={`${card.title} API key`} type="password" autoComplete="off" value={key}
                  placeholder={view.apiKeySet ? `${view.apiKey} (leave empty to keep)` : 'not set'}
                  onChange={(e) => setKey(e.target.value)} className={field} />
              </label>
            </>
          )}
        </div>
      )}
      {kenari && (
        <div className="flex flex-wrap gap-2 mt-4">
          <button className="btn" disabled={busy || !key.trim()} onClick={probeKenari}>Test key</button>
          <button className="btn btn-primary" disabled={busy || !kenariProbe?.ok}
            onClick={() => save({ baseUrl: KENARI_BASE_URL, model: kenariModel, apiKey: key.trim() })}>
            Save
          </button>
        </div>
      )}
      {kenariProbe && (
        <p className={`text-sm mt-2 ${kenariProbe.ok ? 'text-success' : 'text-error'}`}>
          {kenariProbe.ok ? `Key works · ${kenariProbe.model}` : `Failed: ${kenariProbe.error}`}
        </p>
      )}
      {(kind !== 'llm' || mode === 'custom') && (
        <div className="flex flex-wrap gap-2 mt-4">
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => save(patchOf())}>Save</button>
          <button className="btn" disabled={busy} onClick={runTest}>Test</button>
          {view.saved.length > 0 && (
            <button className="btn" disabled={busy} title={`Saved here: ${view.saved.join(', ')}`}
              onClick={() => save(Object.fromEntries(view.saved.map((k) => [k, null])))}>Use .env</button>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-error text-sm mt-2">{error}</p>}
      {test && (
        <p className={`text-sm mt-2 ${test.ok ? 'text-success' : 'text-error'}`}>
          {test.ok
            ? `OK in ${test.ms} ms${test.model ? ` · ${test.model}` : ''}${test.detail ? ` · ${test.detail}` : ''}`
            : `Failed: ${test.error}`}
        </p>
      )}
    </Window>
  );
}

export function ConnectionsPanel({ api, onChange }: { api: ApiClient; onChange?: (c: Connections) => void }) {
  const [conns, setConns] = useState<Connections | null>(null);
  useEffect(() => {
    api.getSettings().then(setConns, (e) => reportError(e, 'getSettings'));
  }, [api]);
  if (!conns) return <p className="font-pixel text-sm">Loading settings…</p>;
  const saved = (c: Connections) => {
    setConns(c);
    onChange?.(c);
  };
  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-3">
        {(['llm', 'jev', 'tebar'] as const).map((k) => (
          <ConnectionCard key={k} kind={k} view={conns[k]} api={api} onSaved={saved} />
        ))}
      </div>
      <GenerateConnections api={api} conns={conns} onSaved={saved} />
    </div>
  );
}
