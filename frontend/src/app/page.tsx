'use client';

// The landing page. One idea runs through it: sorot means spotlight, and the
// product is a beam that finds the forty seconds worth posting in ninety
// minutes of talk. The hero sentence puts that light where a word would be.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { captionSteps, PRESETS } from '@/lib/captionPreview';
import './landing.css';

const STUDIO = '/studio';
const REPO = 'https://github.com/raufimusaddiq/sorot';
const STEP_MS = 420;

function Beam({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`lp-beam ${className}`} />;
}

/** Adds .is-in to [data-reveal] blocks as they enter, once. Content is visible without script. */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    document.documentElement.classList.add('lp-js');
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      }
    }, { rootMargin: '0px 0px -12% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Writes scroll progress to --p on every [data-scroll] element, once per frame.
 * data-scroll="pin": 0 → 1 while a tall section scrolls past its pinned stage.
 * data-scroll="pass": 0 as the top enters at the bottom of the screen, 1 when it reaches the top.
 */
function useScrollVars() {
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const vh = window.innerHeight;
      document.querySelectorAll<HTMLElement>('[data-scroll]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const p = el.dataset.scroll === 'pin' ? clamp01(-r.top / Math.max(r.height - vh, 1)) : clamp01((vh - r.top) / vh);
        el.style.setProperty('--p', p.toFixed(4));
      });
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
}

/** Progress (0–1) of a pinned section, kept in React state for things CSS can't compute. */
function usePinProgress(ref: React.RefObject<HTMLElement>) {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const vh = window.innerHeight;
      if (el.offsetHeight < vh * 1.4) return;          // not pinned at this width
      const r = el.getBoundingClientRect();
      setP(clamp01(-r.top / Math.max(r.height - vh, 1)));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
  return p;
}

const HERO_LINE = 'ini bagian yang paling penting';
const HERO_STEPS = captionSteps(HERO_LINE, PRESETS.default!);
const ease = (t: number) => t * t * (3 - 2 * t);       // smoothstep: slow start, slow finish

/**
 * The sentence with the light in it. Scrolling opens the spotlight strip to the
 * whole screen (the words part to let it through), then the line it found is
 * captioned word by word, the way a render would.
 */
function Hero() {
  const wrap = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLSpanElement>(null);
  const p = usePinProgress(wrap);
  const [inset, setInset] = useState<[number, number, number, number] | null>(null);

  useEffect(() => {
    const measure = () => {
      const s = strip.current?.getBoundingClientRect();
      const stage = strip.current?.closest('.lp-hero')?.getBoundingClientRect();
      if (!s || !stage || !s.width) return;
      setInset([s.top - stage.top, stage.right - s.right, stage.bottom - s.bottom, s.left - stage.left]);
    };
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const open = ease(clamp01(p / 0.7));                  // the strip opens over the first 70%
  const clip = inset ? `inset(${inset.map((v) => `${(v * (1 - open)).toFixed(1)}px`).join(' ')})` : undefined;
  const capStep = p > 0.72 ? HERO_STEPS[Math.min(HERO_STEPS.length - 1, Math.floor(((p - 0.72) / 0.25) * HERO_STEPS.length))] : null;

  return (
    <div className="lp-hero-wrap" ref={wrap}>
      <header className={`lp-hero ${open > 0.45 ? 'is-open' : ''}`} style={{ '--open': open.toFixed(4) } as React.CSSProperties}>
        <div className="lp-spot" style={{ clipPath: clip }} aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/pertunjukan-wayang-kulit.jpg" width={1920} height={1280} alt="" />
          {capStep && (
            <p className="lp-spot-cap">
              {capStep.group.map((w, i) => <span key={`${w}-${i}`} className={i === capStep.active ? 'is-hl' : undefined}>{w} </span>)}
            </p>
          )}
        </div>
        <nav className="lp-nav" aria-label="Main">
          <a href="/" className="lp-wordmark"><Beam />Sorot</a>
          <span className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#faq">Questions</a>
            <a href={REPO}>GitHub</a>
          </span>
        </nav>
        <h1 className="lp-sentence">
          <span className="lp-word lp-w1">90&nbsp;min</span>
          <span className="lp-strip" ref={strip} role="img"
            aria-label="A dalang lifts the gunungan into the lamp's light at a wayang kulit performance" />
          <span className="lp-word lp-w2">40&nbsp;sec</span>
        </h1>
        <div className="lp-hero-foot">
          <p className="lp-hero-line">
            Sorot cuts long Indonesian podcasts into ranked vertical clips with word-timed captions,
            on your own computer. Free and open source.
          </p>
          <a href={STUDIO} className="lp-btn lp-btn-hot">Open the studio</a>
        </div>
        <p className="lp-scroll-cue" aria-hidden>Scroll to find the moment</p>
      </header>
    </div>
  );
}

const EXAMPLES = ['jangan kabur dari masalah', 'gaji pertama cuma tiga juta?', 'ternyata rahasianya sederhana banget'];

function CaptionDemo() {
  const [line, setLine] = useState('ini bagian yang paling penting');
  const [style, setStyle] = useState('default');
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);
  const preset = PRESETS[style]!;
  const steps = captionSteps(line, preset);
  const step = steps.length ? steps[tick % steps.length] : null;

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setTick((n) => n + 1), STEP_MS);
    return () => clearInterval(t);
  }, [playing]);

  // Sizes are a 1080×1920 render scaled to the frame (--k = frame width / 1080).
  const capStyle = {
    '--cap-size': preset.size, '--cap-outline': preset.outline, '--cap-spacing': preset.spacing,
    '--cap-bottom': `${(preset.marginV / 1920) * 100}%`, '--cap-ink': preset.primary,
    '--cap-hl': preset.highlight, '--cap-stroke': preset.outlineColor,
  } as React.CSSProperties;

  return (
    <section className="lp-show" aria-labelledby="show-title" data-reveal>
      <h2 id="show-title" className="lp-statement"><label htmlFor="cap-line">Type a line. Sorot captions it word by word.</label></h2>
      <div className="lp-show-input" data-ui>
        <input id="cap-line" value={line} spellCheck={false} autoComplete="off"
          onChange={(e) => { setLine(e.target.value); setTick(0); }} />
      </div>
      <div className="lp-show-answer">
        <div className="lp-frame" data-ui style={capStyle} role="img"
          aria-label={`A 9:16 clip with the line captioned in the ${preset.label} style`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/pertunjukan-wayang-kulit.jpg" width={1920} height={1280} alt="" loading="lazy" />
          {step && (
            <p className={`lp-cap ${preset.uppercase ? 'is-upper' : ''}`} aria-live="off">
              {step.group.map((w, i) => (
                <span key={`${w}-${i}`} className={i === step.active ? 'is-hl' : undefined}>{w} </span>
              ))}
            </p>
          )}
        </div>
        <div className="lp-show-side">
          <fieldset className="lp-styles">
            <legend>Caption style</legend>
            {Object.entries(PRESETS).map(([key, p]) => (
              <label key={key} className={style === key ? 'is-on' : undefined}>
                <input type="radio" name="cap-style" value={key} checked={style === key}
                  onChange={() => { setStyle(key); setTick(0); }} />
                <span className="lp-swatch" style={{ background: p.highlight }} aria-hidden />
                {p.label}
              </label>
            ))}
          </fieldset>
          <dl className="lp-spec">
            <div><dt>Words on screen</dt><dd>up to {preset.maxWords}</dd></div>
            <div><dt>Letters</dt><dd>{preset.uppercase ? 'capitals' : 'as spoken'}</dd></div>
            <div><dt>Spoken word</dt><dd><span className="lp-swatch" style={{ background: preset.highlight }} aria-hidden /> {preset.highlight}</dd></div>
            <div><dt>Text size</dt><dd>{preset.size}px on 1080×1920</dd></div>
          </dl>
          <p className="lp-small">The same rules burn the captions into every render.</p>
          <button type="button" className="lp-btn" onClick={() => setPlaying((p) => !p)} aria-pressed={!playing}>
            {playing ? 'Pause' : 'Play'}
          </button>
        </div>
      </div>
      <div className="lp-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" onClick={() => { setLine(ex); setTick(0); }}>{ex}</button>
        ))}
      </div>
    </section>
  );
}

const STAGES: Array<{ name: string; clause: string; detail: string; fragment: ReactNode }> = [
  {
    name: 'Paste',
    clause: 'First, paste one long video',
    detail: 'A YouTube link or a file on your disk. Pick a caption style, cut the silences, or process only part of a long episode.',
    fragment: (
      <div className="ui-win">
        <div className="ui-bar ui-aqua">Import</div>
        <div className="ui-body">
          <div className="ui-field">youtu.be/ngobrol-santai-ep41</div>
          <div className="ui-chips"><span className="is-on">Default</span><span>Hormozi</span><span className="is-on">Cut silences</span><span>Hook first</span></div>
          <div className="ui-btn ui-hot">Import &amp; Process</div>
          <p className="ui-note">Only process 13:25 → 58:00</p>
        </div>
      </div>
    ),
  },
  {
    name: 'Listen',
    clause: 'Then it hears every word',
    detail: 'Whisper writes down the talk with a time on every word, or Sorot uses the video’s own YouTube captions when you allow it.',
    fragment: (
      <div className="ui-win">
        <div className="ui-bar ui-mint">Transcript · 1:12:40</div>
        <ol className="ui-lines">
          <li><time>12:04</time> jadi waktu itu aku baru lulus,</li>
          <li><time>12:07</time> gaji pertama <mark>cuma</mark> tiga juta.</li>
          <li><time>12:10</time> terus aku mikir, ini cukup nggak sih?</li>
          <li><time>12:14</time> ternyata yang penting bukan gajinya.</li>
        </ol>
        <p className="ui-note">Whisper large-v3-turbo · a timestamp on every word</p>
      </div>
    ),
  },
  {
    name: 'Rank',
    clause: 'Then it ranks the moments',
    detail: 'Every 10 to 60 second stretch is scored on 13 signals, from the hook in its first line to the faces on screen, best first.',
    fragment: (
      <div className="ui-win">
        <div className="ui-bar ui-sun">Clip #1 · 0:42</div>
        <div className="ui-body">
          <div className="ui-score"><b>84</b>/100 <span className="ui-tier">PRIMARY</span></div>
          <dl className="ui-feats">
            <div><dt>Hook</dt><dd>91</dd></div>
            <div><dt>Clarity</dt><dd>88</dd></div>
            <div><dt>Keywords</dt><dd>80</dd></div>
            <div><dt>Energy</dt><dd>74</dd></div>
          </dl>
          <p className="ui-note">Opens on a question and a number; 13 signals in all</p>
        </div>
      </div>
    ),
  },
  {
    name: 'Post',
    clause: 'Last, you post the clips',
    detail: 'Sorot frames the speaker in 9:16, burns in the captions and writes a title and description. You download and post.',
    fragment: (
      <div className="ui-win">
        <div className="ui-bar ui-lilac">Clips (8)</div>
        <div className="ui-body">
          <p className="ui-title">Gaji pertama cuma 3 juta? Ini yang aku pelajari</p>
          <p className="ui-desc">Wajib tahu ini!<br />#karier #freshgraduate #indonesia</p>
          <div className="ui-row"><span className="ui-btn ui-aqua">Preview</span><span className="ui-btn ui-lilac">Copy</span><span className="ui-btn ui-mint">Download</span></div>
          <p className="ui-note">1080×1920 MP4 · title and description ready to paste</p>
        </div>
      </div>
    ),
  },
];

function StageSlider() {
  const wrap = useRef<HTMLDivElement>(null);
  const p = usePinProgress(wrap);
  const [picked, setPicked] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const pinnedStage = Math.min(STAGES.length - 1, Math.floor(p * STAGES.length));
  useEffect(() => { if (p > 0) setScrolled(true); }, [p]);
  const stage = scrolled ? pinnedStage : picked;
  const current = STAGES[stage]!;

  const go = (i: number) => {
    setPicked(i);
    const el = wrap.current;
    if (el && el.offsetHeight >= window.innerHeight * 1.4) {
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + ((i + 0.5) / STAGES.length) * (el.offsetHeight - window.innerHeight), behavior: 'smooth' });
    } else setScrolled(false);
  };

  return (
    <div className="lp-how-wrap" ref={wrap}>
      <section id="how" className="lp-how" aria-labelledby="how-title">
        <div className="lp-how-clause">
          <p className="lp-how-count" aria-hidden>{stage + 1}<span>/{STAGES.length}</span></p>
          <h2 id="how-title" key={current.clause} className="lp-fade">{current.clause}</h2>
          <p key={current.detail} className="lp-how-detail lp-fade">{current.detail}</p>
        </div>
        <div className="lp-how-ui" data-ui>
          <div key={stage} className="lp-fade">{current.fragment}</div>
        </div>
        <div className="lp-how-track">
          <div className="lp-rail" style={{ '--pct': `${(stage / (STAGES.length - 1)) * 100}%` } as React.CSSProperties}>
            <span className="lp-rail-fill" aria-hidden />
            <input type="range" min={0} max={STAGES.length - 1} step={1} value={stage}
              aria-label="How Sorot works, step by step" aria-valuetext={current.clause}
              onChange={(e) => go(Number(e.target.value))} />
          </div>
          <ol className="lp-how-names">
            {STAGES.map((s, i) => (
              <li key={s.name}>
                <button type="button" className={i === stage ? 'is-on' : undefined} onClick={() => go(i)}>{s.name}</button>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

const FIELDS = [
  { tone: 'sun', phrase: 'Stays on your machine', text: 'Whisper large-v3-turbo transcribes on your own NVIDIA GPU, or on the CPU. Nothing is uploaded, there is no account and no watermark.' },
  { tone: 'aqua', phrase: 'Finds the videos too', text: 'Auto-discover searches the web and YouTube, reads whole captions and picks long videos worth cutting, with a reason for each pick.' },
  { tone: 'tang', phrase: 'Learns your audience', text: 'Tell it how your posted clips did. After five results, Sorot re-weights its 13 scoring signals toward what your viewers watch.' },
  { tone: 'mint', phrase: 'Free and yours', text: 'MIT licence, one repository: a Bun server, a Python media pipeline and this Next.js interface. Change any of it.' },
];

const NEEDS: Array<[string, string, string] | 'gap'> = [
  ['Windows', 'Docker Desktop with WSL2', 'NVIDIA GPU'],
  ['Linux', 'One-command installer', 'NVIDIA or CPU'],
  ['Any OS', 'Docker Compose', 'NVIDIA or CPU'],
  ['macOS', 'Docker Desktop, untested', 'CPU'],
  'gap',
  ['With a GPU', '54-minute video on an RTX 4060', 'about 22 min'],
  ['CPU only', '1 hour of talk transcribed on 12 cores', 'about 30 min'],
  'gap',
  ['Optional', 'Any OpenAI-compatible LLM', 'for reviews'],
  ['Cost', 'MIT licence', 'free'],
];

const CLONE = 'git clone https://github.com/raufimusaddiq/sorot.git\ncd sorot\n';
const INSTALL: Array<{ os: string; note: string; cmd: string }> = [
  { os: 'Windows', note: 'PowerShell. The first build takes about 10 minutes.', cmd: `${CLONE}.\\scripts\\start.ps1 -Build` },
  { os: 'Linux', note: 'Installs Docker and the GPU toolkit if missing, and the sorot CLI.', cmd: `${CLONE}scripts/install.sh` },
  { os: 'Docker', note: 'Any OS with Docker Compose 2.24 or newer.', cmd: `${CLONE}docker compose --env-file .env.docker up -d --build backend` },
];

/** The real install commands, per platform, with a copy button. */
function InstallCard() {
  const [os, setOs] = useState(0);
  const [copied, setCopied] = useState(false);
  const pick = INSTALL[os]!;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pick.cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked: the text stays selectable */ }
  };
  return (
    <div className="lp-install" data-ui>
      <div className="lp-install-tabs" role="tablist" aria-label="Your system">
        {INSTALL.map((o, i) => (
          <button key={o.os} role="tab" aria-selected={i === os} aria-controls="install-cmd"
            className={i === os ? 'is-on' : undefined} onClick={() => { setOs(i); setCopied(false); }}>{o.os}</button>
        ))}
      </div>
      <pre id="install-cmd" role="tabpanel"><code>{pick.cmd}</code></pre>
      <div className="lp-install-foot">
        <p>{pick.note} Then open <b>localhost:8080/studio</b>.</p>
        <button type="button" className="lp-btn lp-btn-sun" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

const FAQ = [
  ['Does my video get uploaded anywhere?', 'No. Downloading, transcribing, scoring and rendering all happen on your machine. The only calls out are the YouTube download and, if you set one, your own LLM endpoint.'],
  ['Is it only for Indonesian?', 'It is built for Indonesian: the hook phrases, keywords and scoring rules read Indonesian. Whisper transcribes other languages, but they rank less well.'],
  ['Do I need an LLM or an API key?', 'No. Without one, rules score the clips and an algorithm picks videos to discover. Add any OpenAI-compatible endpoint and it reviews clips, writes titles and runs the discovery agent.'],
  ['How long does one video take?', 'A 54-minute video took about 22 minutes end to end on an RTX 4060. On a CPU alone, an hour of speech takes about half an hour to transcribe, then the clips render.'],
  ['Can I fix a misheard word?', 'Yes. The clip editor lets you correct words, move the start and end, change the caption style, framing and music, then re-renders just that clip.'],
  ['Does it post the clips for me?', 'Not yet. Each clip comes with a title and description ready to paste. Connectors that post and read back your numbers are next on the roadmap.'],
];

export default function Landing() {
  useReveal();
  useScrollVars();
  return (
    <div className="lp">
      <Hero />
      <main>
        <CaptionDemo />
        <StageSlider />

        <section className="lp-fields" aria-labelledby="field-0">
          {FIELDS.map((f, i) => (
            <div key={f.phrase} className={`lp-field lp-${f.tone} ${i % 2 ? 'is-mirror' : ''}`} data-scroll="pass">
              <p className="lp-field-text">{f.text}</p>
              <h2 id={`field-${i}`} className="lp-field-phrase">{f.phrase}</h2>
            </div>
          ))}
        </section>

        <section className="lp-needs" aria-labelledby="needs-title" data-reveal>
          <div className="lp-needs-main">
            <h2 id="needs-title" className="lp-h2">What it needs</h2>
            <p className="lp-needs-lead">One command on your own machine. No account, nothing to sign up for.</p>
            <InstallCard />
          </div>
          <div className="lp-needs-side">
            <table className="lp-table">
              <caption className="sr-only">Platforms, speed and cost</caption>
              <tbody>
                {NEEDS.map((row, i) => row === 'gap'
                  ? <tr key={`g${i}`} className="lp-gap" aria-hidden><td colSpan={3} /></tr>
                  : (
                    <tr key={row.join()}>
                      <th scope="row">{row[0]}</th>
                      <td>{row[1]}</td>
                      <td>{row[2]}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="faq" className="lp-faq" aria-labelledby="faq-title">
          <div className="lp-faq-head">
            <h2 id="faq-title" className="lp-h2">Before you install</h2>
            <p className="lp-small">Six answers, straight from how Sorot works today.</p>
          </div>
          <div className="lp-faq-list">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lp-choice" aria-labelledby="choice-title" data-scroll="pass">
          <h2 id="choice-title" className="lp-choice-q">
            <span>Got a</span>
            <span>long one?</span>
          </h2>
          <div className="lp-choice-row">
            <a href={STUDIO} className="lp-btn lp-btn-sun">Open the studio</a>
            <span className="lp-or">or</span>
            <a href={`${REPO}#-install`} className="lp-btn lp-btn-paper">Install it</a>
          </div>
          <p className="lp-choice-note">The studio runs at localhost:8080 once Sorot is installed. Installing takes one command.</p>
        </section>
      </main>

      <footer className="lp-foot" data-scroll="pass">
        <div className="lp-foot-top">
          <h2 className="lp-h2">Sorot means spotlight.</h2>
          <dl className="lp-define">
            <div><dt>sorot</dt><dd>a beam of light, the kind a lamp throws on a stage</dd></div>
            <div><dt>sorotan</dt><dd>the highlights: the part everyone remembers</dd></div>
          </dl>
        </div>
        <ul className="lp-foot-links">
          <li><a href={STUDIO}>Open the studio</a></li>
          <li><a href={REPO}>GitHub</a></li>
          <li><a href={`${REPO}/blob/master/docs/cli.md`}>The sorot CLI</a></li>
          <li><a href={`${REPO}/blob/master/docs/linux-install.md`}>Linux install</a></li>
          <li><a href={`${REPO}/blob/master/LICENSE`}>MIT licence</a></li>
        </ul>
        <p className="lp-credits">
          <span>
            Photograph: &ldquo;Pertunjukan Wayang Kulit&rdquo; by FaizAttariqi, <a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>,
            via <a href="https://commons.wikimedia.org/wiki/File:Pertunjukan_Wayang_Kulit.jpg">Wikimedia Commons</a>.
          </span>
          <span>© 2026 Raufi Musaddiq · MIT</span>
        </p>
        <p className="lp-giant" aria-hidden>SOROT</p>
      </footer>
    </div>
  );
}
