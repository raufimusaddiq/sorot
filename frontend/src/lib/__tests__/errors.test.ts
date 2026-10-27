import { reportError, onError, isAbortError } from '../errors';

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('reportError / onError', () => {
  it('notifies listeners with message + context, and unsubscribes', () => {
    const seen: string[] = [];
    const off = onError((msg, ctx) => seen.push(`${ctx}:${msg}`));
    reportError(new Error('boom'), 'pollJob');
    reportError('plain string', 'other');
    off();
    reportError(new Error('after'), 'x');
    expect(seen).toEqual(['pollJob:boom', 'other:plain string']);
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it('a throwing listener does not break other listeners', () => {
    const good = jest.fn();
    const offBad = onError(() => { throw new Error('listener bug'); });
    const offGood = onError(good);
    expect(() => reportError(new Error('e'), 'c')).not.toThrow();
    expect(good).toHaveBeenCalledWith('e', 'c', expect.any(Error));
    offBad(); offGood();
  });
});

describe('isAbortError', () => {
  it('recognises DOM and Error-shaped aborts only', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    const e = new Error('aborted'); e.name = 'AbortError';
    expect(isAbortError(e)).toBe(true);
    expect(isAbortError(new DOMException('x', 'NotFoundError'))).toBe(false);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
