'use client';

// Settings app: the LLM, Jev and Tebar connections. Saved in the app (they
// win over the server's .env); "Use .env" clears them. API keys are never
// shown back — only whether one is set and its last four characters.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import { reportError } from '@/lib/errors';
import type { ConnectionKind, ConnectionTest, ConnectionView, Connections } from '@/types';
import { Toggle } from './ImportOptions';
import { Window } from './Window';

type FieldDef = { key: 'baseUrl' | 'url' | 'model'; label: string; placeholder: string };

const CARDS: Record<ConnectionKind, { title: string; bar: string; about: string; fallback: string; fields: FieldDef[] }> = {
  llm: {
    title: 'LLM', bar: 'bg-lilac',
    about: 'Any OpenAI-compatible endpoint (Ollama, LM Studio, Groq, OpenRouter, OpenAI…). Reviews clips, writes copy and, as director, reads the whole video to pick moments and hooks.',
    fallback: 'Off: the rules find, score and title the clips.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'http://localhost:11434/v1' },
      { key: 'model', label: 'Model', placeholder: 'qwen2.5:7b' },
    ],
  },
  jev: {
    title: 'Jev quality gate', bar: 'bg-aqua',
    about: 'TypeSafe’s decision model answers fixed yes/no questions about each clip (hook, needs context, ending, filler, payoff, content risks) and checks the LLM’s titles and post copy.',
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

const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';

function ConnectionCard({ kind, view, api, onSaved }: {
  kind: ConnectionKind; view: ConnectionView; api: ApiClient; onSaved: (c: Connections) => void;
}) {
  const card = CARDS[kind];
  const [form, setForm] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);

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

  const dirty = Object.keys(patchOf()).length > 0;
  return (
    <Window title={card.title} bar={card.bar} right={view.active ? 'active' : 'off'}>
      <p className="text-sm text-fg/80 mb-1">{card.about}</p>
      {!view.active && <p className="text-xs text-subtle mb-3">{card.fallback}</p>}
      <div className="grid gap-3 mt-3">
        <Toggle checked={view.enabled} onChange={(v) => save({ enabled: v })}>
          <span>Use {card.title}</span>
        </Toggle>
        {kind === 'llm' && (
          <Toggle checked={!!view.director} onChange={(v) => save({ director: v })}>
            <span>Director: read the whole video, pick moments and hooks (more LLM calls)</span>
          </Toggle>
        )}
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
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => save(patchOf())}>Save</button>
        <button className="btn" disabled={busy} onClick={runTest}>Test</button>
        {view.saved.length > 0 && (
          <button className="btn" disabled={busy} title={`Saved here: ${view.saved.join(', ')}`}
            onClick={() => save(Object.fromEntries(view.saved.map((k) => [k, null])))}>Use .env</button>
        )}
      </div>
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
    <div className="grid gap-6 lg:grid-cols-3">
      {(['llm', 'jev', 'tebar'] as const).map((k) => (
        <ConnectionCard key={k} kind={k} view={conns[k]} api={api} onSaved={saved} />
      ))}
    </div>
  );
}
