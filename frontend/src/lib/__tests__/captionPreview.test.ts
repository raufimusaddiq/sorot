import { captionSteps, groupWords, lineWords, PRESETS } from '../captionPreview';

describe('caption preview (mirrors ai-pipeline/captions.py)', () => {
  it('folds standalone punctuation and reduplication halves into the word before', () => {
    expect(lineWords('  jangan kabur , dari  masalah !  ')).toEqual(['jangan', 'kabur,', 'dari', 'masalah!']);
    expect(lineWords('gedung -gedung {tinggi}')).toEqual(['gedung-gedung', 'tinggi']);
    expect(lineWords('. awal')).toEqual(['.', 'awal']);
    expect(lineWords('   ')).toEqual([]);
  });

  it('groups by word count, character budget and sentence ends, per preset', () => {
    const words = lineWords('jangan kabur dari masalah. hadapi pelan-pelan saja');
    expect(groupWords(words, PRESETS.default!)).toEqual([['jangan', 'kabur', 'dari'], ['masalah.'], ['hadapi', 'pelan-pelan'], ['saja']]);
    expect(groupWords(words, PRESETS.hormozi!)).toEqual([['jangan', 'kabur'], ['dari', 'masalah.'], ['hadapi'], ['pelan-pelan'], ['saja']]);
    expect(groupWords(words, PRESETS.storyteller!)).toEqual([['jangan', 'kabur', 'dari'], ['masalah.'], ['hadapi', 'pelan-pelan', 'saja']]);
    expect(groupWords([], PRESETS.default!)).toEqual([]);
  });

  it('steps through every word of every screen in order', () => {
    const steps = captionSteps('satu dua tiga empat', PRESETS.hormozi!);
    expect(steps.map((s) => `${s.group.join(' ')}:${s.active}`)).toEqual(['satu dua:0', 'satu dua:1', 'tiga empat:0', 'tiga empat:1']);
  });
});
