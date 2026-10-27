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

function Hero() {
  return (
    <header className="lp-hero">
      <nav className="lp-nav" aria-label="Main">
        <a href="/" className="lp-wordmark"><Beam />Sorot</a>
        <span className="lp-nav-links">
          <a href="#how">How it works</a>
          <a href="#faq">Questions</a>
          <a href={REPO}>GitHub</a>
        </span>
      </nav>
      <h1 className="lp-sentence">
        <span className="lp-word">90&nbsp;min</span>
        <span className="lp-strip">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/pertunjukan-wayang-kulit.jpg" width={1920} height={1280}
            alt="A dalang lifts the gunungan into the lamp's light at a wayang kulit performance" />
        </span>
        <span className="lp-word">40&nbsp;sec</span>
      </h1>
      <a href={STUDIO} className="lp-btn lp-btn-hot lp-hero-action">Open the studio</a>
      <p className="lp-hero-line">
        Sorot cuts long Indonesian podcasts into ranked vertical clips with word-timed captions,
        on your own computer. Free and open source.
      </p>
    </header>
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
          <p className="lp-small">
            {preset.maxWords} words a screen at most, the spoken word in {preset.label.toLowerCase()} colour.
            The same rules burn the captions into every render.
          </p>
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

const STAGES: Array<{ name: string; clause: string; fragment: ReactNode }> = [
  {
    name: 'Paste',
    clause: 'First, paste one long video',
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
  const [stage, setStage] = useState(0);
  const current = STAGES[stage]!;
  return (
    <section id="how" className="lp-how" aria-labelledby="how-title">
      <div className="lp-how-clause">
        <h2 id="how-title" key={current.clause} className="lp-fade">{current.clause}</h2>
      </div>
      <div className="lp-how-ui" data-ui>
        <div key={stage} className="lp-fade">{current.fragment}</div>
      </div>
      <div className="lp-how-track">
        <div className="lp-rail" style={{ '--pct': `${(stage / (STAGES.length - 1)) * 100}%` } as React.CSSProperties}>
          <span className="lp-rail-fill" aria-hidden />
          <input type="range" min={0} max={STAGES.length - 1} step={1} value={stage}
            aria-label="How Sorot works, step by step" aria-valuetext={current.clause}
            onChange={(e) => setStage(Number(e.target.value))} />
        </div>
        <ol className="lp-how-names">
          {STAGES.map((s, i) => (
            <li key={s.name}>
              <button type="button" className={i === stage ? 'is-on' : undefined} onClick={() => setStage(i)}>{s.name}</button>
            </li>
          ))}
        </ol>
      </div>
    </section>
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
  ['Speed', '54-minute video on an RTX 4060', 'about 22 min'],
  ['Speed', '1 hour transcribed on a 12-core CPU', 'about 30 min'],
  'gap',
  ['Optional', 'Any OpenAI-compatible LLM', 'for reviews'],
  ['Cost', 'MIT licence', 'free'],
];

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
  return (
    <div className="lp">
      <Hero />
      <main>
        <CaptionDemo />
        <StageSlider />

        <section className="lp-fields" aria-labelledby="field-0">
          {FIELDS.map((f, i) => (
            <div key={f.phrase} className={`lp-field lp-${f.tone} ${i % 2 ? 'is-mirror' : ''}`} data-reveal>
              <p className="lp-field-text">{f.text}</p>
              <h2 id={`field-${i}`} className="lp-field-phrase">{f.phrase}</h2>
            </div>
          ))}
        </section>

        <section className="lp-needs" aria-labelledby="needs-title" data-reveal>
          <h2 id="needs-title" className="lp-h2 lp-indent">What it needs to run</h2>
          <div className="lp-needs-body">
            <figure className="lp-needs-photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/wayang-kulit-1890.jpg" width={1920} height={1543} loading="lazy"
                alt="A dalang seated before his wayang puppets, Java, around 1890" />
              <figcaption>A dalang and his puppets, Java, around 1890.</figcaption>
            </figure>
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

        <section id="faq" className="lp-faq" aria-labelledby="faq-title" data-reveal>
          <h2 id="faq-title" className="lp-h2">Before you install</h2>
          <div className="lp-faq-list">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lp-choice" aria-labelledby="choice-title">
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

      <footer className="lp-foot">
        <div className="lp-foot-top">
          <div>
            <h2 className="lp-h2">Sorot means spotlight.</h2>
            <a href={STUDIO} className="lp-btn lp-btn-hot">Open the studio</a>
          </div>
          <ul className="lp-foot-links">
            <li><a href={REPO}>GitHub</a></li>
            <li><a href={`${REPO}/blob/master/docs/cli.md`}>The sorot CLI</a></li>
            <li><a href={`${REPO}/blob/master/docs/linux-install.md`}>Linux install</a></li>
            <li><a href={`${REPO}/blob/master/LICENSE`}>MIT licence</a></li>
          </ul>
        </div>
        <p className="lp-credits">
          <span>
            Photographs: &ldquo;Pertunjukan Wayang Kulit&rdquo; by FaizAttariqi, <a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>,
            via <a href="https://commons.wikimedia.org/wiki/File:Pertunjukan_Wayang_Kulit.jpg">Wikimedia Commons</a>;
            &ldquo;<a href="https://commons.wikimedia.org/wiki/File:Wayang_Kulit_1890.jpg">Wayang Kulit 1890</a>&rdquo;, public domain.
          </span>
          <span>© 2026 Raufi Musaddiq · MIT</span>
        </p>
        <p className="lp-giant" aria-hidden>SOROT</p>
      </footer>
    </div>
  );
}
