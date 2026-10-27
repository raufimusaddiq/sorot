// The caption presets and grouping rules from ai-pipeline/captions.py, so the
// landing page's preview shows a line the way a render would: same words per
// screen, same case, same highlight colour on the word being spoken.

export type CaptionPreset = {
  label: string;
  size: number;          // px on a 1080×1920 frame
  uppercase: boolean;
  primary: string;
  highlight: string;
  outlineColor: string;
  outline: number;       // px on a 1080-wide frame
  spacing: number;
  marginV: number;       // px from the bottom of a 1920-tall frame
  maxWords: number;
  maxChars: number;
};

export const PRESETS: Record<string, CaptionPreset> = {
  default: {
    label: 'Default', size: 76, uppercase: true, primary: '#FFFFFF', highlight: '#FFE600',
    outlineColor: '#000000', outline: 6, spacing: 1, marginV: 440, maxWords: 3, maxChars: 18,
  },
  hormozi: {
    label: 'Hormozi', size: 86, uppercase: true, primary: '#FFFFFF', highlight: '#39FF14',
    outlineColor: '#000000', outline: 7, spacing: 1, marginV: 460, maxWords: 2, maxChars: 14,
  },
  storyteller: {
    label: 'Storyteller', size: 66, uppercase: false, primary: '#F5F5F5', highlight: '#5EEAD4',
    outlineColor: '#1F1F1F', outline: 4, spacing: 0, marginV: 400, maxWords: 4, maxChars: 24,
  },
  cinematic: {
    label: 'Cinematic', size: 64, uppercase: true, primary: '#FFFFFF', highlight: '#FFB000',
    outlineColor: '#000000', outline: 4, spacing: 4, marginV: 420, maxWords: 3, maxChars: 20,
  },
};

const PUNCT_ONLY = /^[.,?!;:\-–—…"'“”‘’()[\]]+$/;
const TERMINAL = /[.?!…]["'”’)\]]*$/;

/** Words of a typed line, with standalone punctuation folded into the word before (as sanitize_words does). */
export function lineWords(line: string): string[] {
  const out: string[] = [];
  for (const raw of line.trim().split(/\s+/)) {
    const t = raw.replace(/[{}\\]/g, '');
    if (!t) continue;
    if ((PUNCT_ONLY.test(t) || (t.startsWith('-') && t.length > 1)) && out.length) out[out.length - 1] += t;
    else out.push(t);
  }
  return out;
}

/** group_words(): a screen ends at maxWords, when the next word would pass maxChars, or after a sentence end. */
export function groupWords(words: string[], preset: CaptionPreset): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    if (cur.length) {
      const chars = cur.reduce((n, x) => n + x.length + 1, 0) + w.length;
      if (cur.length >= preset.maxWords || chars > preset.maxChars || TERMINAL.test(cur[cur.length - 1]!)) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** The screens of a line, flattened to (group, word) steps in speaking order. */
export function captionSteps(line: string, preset: CaptionPreset): Array<{ group: string[]; active: number }> {
  return groupWords(lineWords(line), preset).flatMap((group) => group.map((_, active) => ({ group, active })));
}
