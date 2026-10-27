import { act, fireEvent, render, screen, within } from '@testing-library/react';
import Landing from '../page';

describe('landing page', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  it('says what Sorot is and sends visitors to the studio', () => {
    render(<Landing />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(/90\s*min/i);
    expect(within(h1).getByRole('img')).toHaveAttribute('alt', expect.stringContaining('gunungan'));
    expect(screen.getByText(/ranked vertical clips with word-timed captions/)).toBeInTheDocument();
    const studio = screen.getAllByRole('link', { name: 'Open the studio' });
    expect(studio.length).toBeGreaterThanOrEqual(3);
    studio.forEach((a) => expect(a).toHaveAttribute('href', '/studio'));
    expect(screen.getByRole('link', { name: 'Install it' })).toHaveAttribute('href', expect.stringContaining('#-install'));
    // without IntersectionObserver every section is shown at once
    document.querySelectorAll('[data-reveal]').forEach((el) => expect(el).toHaveClass('is-in'));
  });

  it('captions a typed line word by word, in the chosen style', () => {
    jest.useFakeTimers();
    render(<Landing />);
    const frame = screen.getByRole('img', { name: /Default style/ });
    const spoken = () => frame.querySelector('.is-hl')?.textContent?.trim();
    expect(spoken()).toBe('ini');
    act(() => { jest.advanceTimersByTime(420); });
    expect(spoken()).toBe('bagian');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gaji pertama cuma tiga juta?' } });
    expect(frame.textContent).toContain('gaji');
    fireEvent.click(screen.getByLabelText('Hormozi'));
    expect(screen.getByRole('img', { name: /Hormozi style/ })).toBeInTheDocument();
    expect(screen.getByText(/2 words a screen at most/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const before = spoken();
    act(() => { jest.advanceTimersByTime(2000); });
    expect(spoken()).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));

    fireEvent.click(screen.getByRole('button', { name: 'jangan kabur dari masalah' }));
    expect(screen.getByRole('textbox')).toHaveValue('jangan kabur dari masalah');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(frame.querySelector('.lp-cap')).toBeNull();
  });

  it('the slider and the stage names drive the how-it-works halves', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { name: 'First, paste one long video' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How Sorot works, step by step'), { target: { value: '2' } });
    expect(screen.getByRole('heading', { name: 'Then it ranks the moments' })).toBeInTheDocument();
    expect(screen.getByText('PRIMARY')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.getByRole('heading', { name: 'Last, you post the clips' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(screen.getByText(/a timestamp on every word/)).toBeInTheDocument();
  });

  it('reveals sections as they enter, once', () => {
    const observed: Element[] = [];
    let callback: IntersectionObserverCallback = () => {};
    const unobserve = jest.fn();
    (window as { IntersectionObserver?: unknown }).IntersectionObserver = jest.fn((cb: IntersectionObserverCallback) => {
      callback = cb;
      return { observe: (el: Element) => observed.push(el), unobserve, disconnect: jest.fn() };
    });
    const { unmount } = render(<Landing />);
    expect(observed.length).toBeGreaterThan(3);
    act(() => callback([
      { isIntersecting: true, target: observed[0]! },
      { isIntersecting: false, target: observed[1]! },
    ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(observed[0]).toHaveClass('is-in');
    expect(observed[1]).not.toHaveClass('is-in');
    expect(unobserve).toHaveBeenCalledWith(observed[0]);
    unmount();
  });

  it('answers the questions before install', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { name: 'Before you install' })).toBeInTheDocument();
    expect(screen.getByText('Does my video get uploaded anywhere?')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('about 22 min');
  });
});
