import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(within(h1).getByRole('img', { name: /gunungan/ })).toBeInTheDocument();
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
    expect(screen.getByText('up to 2')).toBeInTheDocument();
    expect(screen.getByText('#39FF14')).toBeInTheDocument();

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
    expect(observed.length).toBeGreaterThanOrEqual(2);
    act(() => callback([
      { isIntersecting: true, target: observed[0]! },
      { isIntersecting: false, target: observed[1]! },
    ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(observed[0]).toHaveClass('is-in');
    expect(observed[1]).not.toHaveClass('is-in');
    expect(unobserve).toHaveBeenCalledWith(observed[0]);
    unmount();
  });

  it('scrolling opens the spotlight, captions it, and steps through the stages', () => {
    const rect = { top: -1000, bottom: 1000, left: 0, right: 1000, width: 1000, height: 2000, x: 0, y: -1000, toJSON: () => ({}) };
    const spies = [
      jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect),
      jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(2000),
      jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; }),
    ];
    const scrollTo = jest.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    try {
      const { unmount } = render(<Landing />);
      act(() => { window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); });
      // pinned progress = 1000 / (2000 - 800) ≈ 0.83: the strip is open and the caption is playing
      expect(document.querySelector('.lp-spot-cap')).not.toBeNull();
      expect(document.querySelector('.lp-spot')!.getAttribute('style')).toContain('inset(');
      expect(screen.getByRole('heading', { name: 'Last, you post the clips' })).toBeInTheDocument();
      expect(document.querySelector<HTMLElement>('[data-scroll]')!.style.getPropertyValue('--p')).toBe('1.0000');
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
      unmount();
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  });

  it('with reduced motion nothing is pinned to the scroll', () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    try {
      render(<Landing />);
      act(() => { window.dispatchEvent(new Event('scroll')); });
      expect(document.querySelector('.lp-spot-cap')).toBeNull();
      expect(document.querySelector<HTMLElement>('[data-scroll]')!.style.getPropertyValue('--p')).toBe('');
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('shows the real install command per system and copies it', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Landing />);
    expect(screen.getByRole('heading', { name: 'What it needs' })).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('start.ps1 -Build');
    fireEvent.click(screen.getByRole('tab', { name: 'Linux' }));
    expect(screen.getByRole('tab', { name: 'Linux' })).toHaveAttribute('aria-selected', 'true');
    expect(panel).toHaveTextContent('scripts/install.sh');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('git clone https://github.com/raufimusaddiq/sorot.git'));
    fireEvent.click(screen.getByRole('tab', { name: 'Docker' }));
    expect(panel).toHaveTextContent('docker compose --env-file .env.docker up -d --build backend');
    // a blocked clipboard leaves the command on screen, no crash
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText('sorotan')).toBeInTheDocument();
  });

  it('answers the questions before install', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { name: 'Before you install' })).toBeInTheDocument();
    expect(screen.getByText('Does my video get uploaded anywhere?')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('about 22 min');
  });
});
