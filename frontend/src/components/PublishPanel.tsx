'use client';

// Publish one clip through Tebar: pick accounts (one workspace per post) → the
// LLM drafts copy per platform (Jev checks it) → you edit it and make the
// choices only you can (TikTok privacy or a draft to the TikTok app, YouTube
// "made for kids") → post now or schedule. Earlier posts of the clip are listed
// with their status and links; failed ones can be retried, scheduled ones cancelled.

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api';
import type { Clip, DraftTarget, PublishDraft, SocialAccount, SocialPost } from '@/types';

const GATE_BLOCK = 'Held back by the quality gate';
const label = 'font-pixel text-xs text-fg block mb-1';
const field = 'field w-full px-2 py-1.5';
/** localStorage key of the accounts picked last time. */
export const SAVED_ACCOUNTS = 'sorot.publish.accounts';

type PostMode = 'direct' | 'draft';
type Choice = { content: string; title?: string; madeForKids?: boolean; privacyLevel?: string; postMode?: PostMode };
type PostAction = 'refreshPost' | 'retryPost' | 'cancelPost';

const MODES: ReadonlyArray<[PostMode, string]> = [['direct', 'Post directly'], ['draft', 'Send as a draft to the TikTok app']];
const ROW_ACTIONS: ReadonlyArray<[PostAction, string, (status: string) => boolean]> = [
  ['retryPost', 'Retry', (s) => s === 'FAILED' || s === 'PARTIAL'],
  ['cancelPost', 'Cancel', (s) => s === 'SCHEDULED'],
  ['refreshPost', 'Refresh', () => true],
];

/** "2026-11-01T19:00" (datetime-local, the viewer's zone) → ISO with a zone. */
export const scheduleIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

const workspaceOf = (a: SocialAccount) => a.profileId ?? '';

/** The remembered accounts that are still listed and postable, kept to one workspace. */
function preselect(accounts: SocialAccount[]): Set<string> {
  let saved: unknown = [];
  try {
    saved = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS) ?? '[]');
  } catch { /* no storage: start empty */ }
  const ids = new Set(Array.isArray(saved) ? saved : []);
  const ok = accounts.filter((a) => a.supported && ids.has(a.id));
  return new Set(ok.filter((a) => workspaceOf(a) === workspaceOf(ok[0]!)).map((a) => a.id));
}

function AccountPicker({ accounts, selected, onSelect }: {
  accounts: SocialAccount[]; selected: Set<string>; onSelect: (ids: Set<string>) => void;
}) {
  const groups = new Map<string, SocialAccount[]>();
  for (const a of accounts) groups.set(workspaceOf(a), [...(groups.get(workspaceOf(a)) ?? []), a]);
  const named = accounts.some((a) => a.profileId);
  const picked = accounts.find((a) => selected.has(a.id));
  const active = picked ? workspaceOf(picked) : null;
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelect(next);
  };
  return (
    <div>
      <span className={label}>Post to</span>
      {active !== null && groups.size > 1 && <p className="text-xs text-subtle mb-1">A post goes to one workspace at a time.</p>}
      {[...groups].map(([ws, list]) => {
        const locked = active !== null && ws !== active;
        const postable = list.filter((a) => a.supported);
        return (
          <fieldset key={ws} className="mb-2">
            {named && <legend className="font-pixel text-xs text-muted mb-1">{list[0]!.profileName ?? 'Default workspace'}</legend>}
            <div className="flex flex-wrap items-center gap-3">
              {list.map((a) => (
                <label key={a.id} className={`text-sm flex items-center gap-1 ${!a.supported || locked ? 'text-subtle' : ''}`}>
                  <input type="checkbox" checked={selected.has(a.id)} disabled={!a.supported || locked} onChange={() => toggle(a.id)} />
                  {a.name} <span className="text-subtle">({a.platform}){a.supported ? '' : " · can't post a video here"}</span>
                </label>
              ))}
              <button type="button" className="font-pixel text-xs underline" disabled={locked || postable.length === 0}
                onClick={() => onSelect(new Set(postable.map((a) => a.id)))}>Select all</button>
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

function PostRow({ post, busy, onAction }: { post: SocialPost; busy: boolean; onAction: (a: PostAction) => void }) {
  let targets: Array<{ platform: string; status: string; permalink: string | null; errorCode: string | null }> = [];
  try {
    targets = JSON.parse(post.targets ?? '[]');
  } catch { /* unreadable → none */ }
  return (
    <li className="border-2 border-line rounded p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-pixel">{post.status}{post.scheduledAt ? ` · ${new Date(post.scheduledAt).toLocaleString()}` : ''}</span>
        <span className="flex gap-3">
          {ROW_ACTIONS.filter(([, , shows]) => shows(post.status)).map(([action, text]) => (
            <button key={action} className="font-pixel text-xs underline" disabled={busy} onClick={() => onAction(action)}>{text}</button>
          ))}
        </span>
      </div>
      {targets.map((t, i) => (
        <p key={i} className="text-xs text-muted">
          {t.platform}: {t.status}{t.errorCode ? ` (${t.errorCode})` : ''}{' '}
          {t.permalink && <a href={t.permalink} target="_blank" rel="noreferrer" className="text-accent underline">open</a>}
        </p>
      ))}
      {post.errorMessage && <p className="text-xs text-error">{post.errorMessage}</p>}
    </li>
  );
}

function TargetEditor({ t, choice, onChange }: { t: DraftTarget; choice: Choice; onChange: (c: Choice) => void }) {
  const direct = choice.postMode !== 'draft';
  return (
    <div className="border-3 border-line rounded-md p-3 bg-surface">
      <p className="font-pixel text-sm mb-2">{t.name} · {t.platform}
        <span className="text-xs text-subtle"> · copy by {t.copyBy === 'llm' ? 'LLM' : 'template'}</span></p>
      {t.platform === 'youtube' && (
        <label className="block mb-2">
          <span className={label}>YouTube title</span>
          <input aria-label={`Title for ${t.name}`} maxLength={100} value={choice.title ?? ''} className={field}
            onChange={(e) => onChange({ ...choice, title: e.target.value })} />
        </label>
      )}
      <label className="block">
        <span className={label}>Text ({[...choice.content].length} characters)</span>
        <textarea aria-label={`Text for ${t.name}`} rows={4} value={choice.content} className={`${field} resize-y`}
          onChange={(e) => onChange({ ...choice, content: e.target.value })} />
      </label>
      {t.needs.madeForKids && (
        <fieldset className="mt-2 text-sm">
          <legend className={label}>Made for kids? (YouTube asks every upload)</legend>
          {[['No', false], ['Yes', true]].map(([text, v]) => (
            <label key={String(text)} className="mr-4">
              <input type="radio" name={`kids-${t.accountId}`} checked={choice.madeForKids === v}
                onChange={() => onChange({ ...choice, madeForKids: v as boolean })} /> {text}
            </label>
          ))}
        </fieldset>
      )}
      {t.platform === 'tiktok' && (
        <fieldset className="mt-2 text-sm">
          <legend className={label}>How to send it to TikTok</legend>
          {MODES.map(([mode, text]) => (
            <label key={mode} className="mr-4">
              <input type="radio" name={`mode-${t.accountId}`} checked={(choice.postMode ?? 'direct') === mode}
                onChange={() => onChange({ ...choice, postMode: mode })} /> {text}
            </label>
          ))}
          {!direct && <p className="text-xs text-subtle mt-1">It waits in the TikTok app&apos;s inbox: finish it and choose who can see it there.</p>}
        </fieldset>
      )}
      {t.needs.tiktokPrivacy && direct && (
        <label className="block mt-2">
          <span className={label}>Who can see it (TikTok asks you to choose)</span>
          <select aria-label={`Privacy for ${t.name}`} value={choice.privacyLevel ?? ''} className={field}
            onChange={(e) => onChange({ ...choice, privacyLevel: e.target.value })}>
            <option value="">Choose…</option>
            {t.needs.tiktokPrivacy.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
      {t.warnings.map((w) => <p key={w} className="text-xs text-warning mt-1">⚠ {w}</p>)}
      {t.blockers.filter((b) => !b.startsWith(GATE_BLOCK)).map((b) => <p key={b} className="text-xs text-error mt-1">✗ {b}</p>)}
    </div>
  );
}

export function PublishPanel({ clip, api, onClose }: { clip: Clip; api: ApiClient; onClose: () => void }) {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [schedule, setSchedule] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.socialAccounts().then((r) => {
      setAccounts(r.accounts);
      setSelected(preselect(r.accounts));
    }, (e) => setError((e as Error).message));
    api.clipPosts(clip.id).then((r) => setPosts(r.posts), () => {});
  }, [api, clip.id]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const choose = (ids: Set<string>) => {
    setSelected(ids);
    try {
      localStorage.setItem(SAVED_ACCOUNTS, JSON.stringify([...ids]));
    } catch { /* no storage: nothing is pre-selected next time */ }
  };

  const postAction = (id: string, action: PostAction) => run(async () => {
    const { post } = await api[action](id);
    setPosts((all) => all.map((x) => (x.id === post.id ? post : x)));
  });

  const writeCopy = () => run(async () => {
    const d = await api.publishDraft(clip.id, [...selected]);
    setDraft(d);
    setConfirmed(false);
    setChoices(Object.fromEntries(d.targets.map((t): [string, Choice] =>
      [t.accountId, { content: t.content, title: t.title, ...(t.platform === 'tiktok' ? { postMode: 'direct' } : {}) }])));
  });

  const gate = draft?.clip.gateVerdict;
  const missing = draft ? draft.targets.some((t) => {
    const c = choices[t.accountId]!;
    return (t.needs.madeForKids && c.madeForKids === undefined) || (t.needs.tiktokPrivacy && c.postMode !== 'draft' && !c.privacyLevel)
      || (t.platform === 'youtube' && !c.title?.trim())
      || t.blockers.some((b) => !b.startsWith(GATE_BLOCK) || !confirmed);
  }) : true;
  const blocked = missing || (gate === 'REVIEW' && !confirmed);

  const publish = () => run(async () => {
    const r = await api.publish(clip.id, {
      targets: draft!.targets.map((t) => {
        const { privacyLevel, ...c } = choices[t.accountId]!;   // a TikTok draft gets its privacy in the app
        return { accountId: t.accountId, ...c, ...(privacyLevel && c.postMode !== 'draft' ? { privacyLevel } : {}) };
      }),
      ...(schedule ? { scheduledAt: scheduleIso(schedule) } : {}),
      ...(gate === 'REVIEW' ? { confirmReview: true } : {}),
      ...(gate === 'FAIL' ? { override: true } : {}),
    });
    setPosts((p) => [r.post, ...p]);
    setDraft(null);
  });

  return (
    <div className="fixed inset-0 bg-bg/80 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="win max-w-2xl w-full" role="dialog" aria-label="Publish clip">
        <div className="win-bar bg-mint">
          <button onClick={onClose} aria-label="Close" className="close grid place-items-center text-[9px] leading-none text-white">✕</button>
          <span className="stripes" aria-hidden />
          <h3 className="heading text-base px-1">Publish #{clip.rankPos} via Tebar</h3>
          <span className="stripes" aria-hidden />
        </div>
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          {accounts === null && !error && <p className="font-pixel text-sm">Loading accounts…</p>}
          {accounts && accounts.length === 0 && (
            <p className="text-sm">No accounts yet: connect TikTok, Instagram, YouTube… at tebar.app, then reopen this.</p>
          )}
          {accounts && accounts.length > 0 && (
            <div>
              <AccountPicker accounts={accounts} selected={selected} onSelect={choose} />
              <button className="btn mt-1" disabled={busy || selected.size === 0} onClick={writeCopy}>
                {draft ? 'Rewrite copy' : 'Write copy'}
              </button>
            </div>
          )}
          {draft && (
            <>
              {draft.copyCheckedBy && <p className="text-xs text-subtle">Copy checked by {draft.copyCheckedBy}.</p>}
              {draft.targets.map((t) => (
                <TargetEditor key={t.accountId} t={t} choice={choices[t.accountId]!}
                  onChange={(c) => setChoices({ ...choices, [t.accountId]: c })} />
              ))}
              {(gate === 'REVIEW' || gate === 'FAIL') && (
                <label className="flex items-start gap-2 text-sm bg-sun/40 border-2 border-line rounded p-2">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  <span>{gate === 'FAIL' ? 'Post anyway — the quality gate held this clip back: ' : 'I checked it — the quality gate asks for a review: '}
                    {draft.clip.gateReasons.join('; ') || 'no reason given'}</span>
                </label>
              )}
              <label className="block">
                <span className={label}>Schedule (optional, your time zone)</span>
                <input aria-label="Schedule" type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} className={field} />
              </label>
              <button className="btn btn-primary" disabled={busy || blocked} onClick={publish}>
                {busy ? 'Sending…' : schedule ? 'Schedule' : 'Publish now'}
              </button>
            </>
          )}
          {error && <p role="alert" className="text-error text-sm">{error}</p>}
          {posts.length > 0 && (
            <div>
              <span className={label}>Posts of this clip</span>
              <ul className="space-y-2">
                {posts.map((p) => (
                  <PostRow key={p.id} post={p} busy={busy} onAction={(a) => postAction(p.id, a)} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
