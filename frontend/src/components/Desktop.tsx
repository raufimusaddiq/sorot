// Desktop chrome: the menu bar along the top and the dock along the bottom.

import { useEffect, useState, type ReactNode } from 'react';

/** "RAB 28 OKT 2026" and "03:14", the menu bar clock (Indonesian, like the app). */
export function clockText(d: Date): { date: string; time: string } {
  const date = d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .replace(/[.,]/g, '').toUpperCase();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

export function MenuBar({ tagline }: { tagline: string }) {
  // Rendered after mount only: the page is a static export, so a build-time clock would be wrong.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const clock = now ? clockText(now) : null;
  const cell = 'flex items-center px-3 sm:px-4 border-line font-pixel text-sm';
  return (
    <header className="fixed inset-x-0 top-0 z-40 flex h-9 bg-surface border-b-3 border-line">
      <h1 className={`${cell} gap-2 bg-fg text-sun border-r-3 heading text-base`}>
        <span aria-hidden className="w-5 h-4 bg-sun [clip-path:polygon(0_38%,100%_0,100%_100%,0_62%)]" />
        Sorot
      </h1>
      <p className={`${cell} hidden md:flex border-r-3 font-sans text-xs text-muted`}>{tagline}</p>
      <span className="flex-1" />
      {clock && (
        <>
          <span className={`${cell} hidden sm:flex border-l-3`}>{clock.date}</span>
          <span className={`${cell} border-l-3`}>{clock.time}</span>
        </>
      )}
    </header>
  );
}

export type DockApp<K extends string> = { key: K; label: string; icon: ReactNode; badge?: number };

export function Dock<K extends string>({ apps, current, onOpen }: {
  apps: DockApp<K>[]; current: K; onOpen: (key: K) => void;
}) {
  return (
    <nav aria-label="Apps"
      className="fixed bottom-0 left-1/2 -translate-x-1/2 z-40 flex bg-surface border-3 border-b-0 border-line rounded-t-card shadow-[6px_0_0_#000]">
      {apps.map((app, i) => (
        <button key={app.key} onClick={() => onOpen(app.key)} aria-current={current === app.key ? 'page' : undefined}
          className={`relative flex flex-col items-center gap-1 w-24 sm:w-28 pt-2 pb-1.5 font-pixel text-xs ${
            i > 0 ? 'border-l-3 border-line' : ''
          } ${current === app.key ? 'bg-sun' : 'hover:bg-surface-3'}`}>
          <span aria-hidden className="dock-icon block w-8 h-8 [&>svg]:w-full [&>svg]:h-full">{app.icon}</span>
          {app.label}
          {app.badge ? (
            <span aria-hidden className="absolute top-1 right-3 bg-fg text-sun rounded-full px-1.5 text-[10px] leading-4">{app.badge}</span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

const stroke = { stroke: '#000', strokeWidth: 1.2 };

/** Small pixel-style app icons (20×20 grid). */
export const ICONS = {
  import: (
    <svg viewBox="0 0 20 20" shapeRendering="crispEdges"><rect x="2" y="5" width="16" height="11" fill="#FF7A3D" {...stroke} />
      <circle cx="7" cy="10.5" r="2.4" fill="#FBF3EA" {...stroke} /><circle cx="13" cy="10.5" r="2.4" fill="#FBF3EA" {...stroke} /></svg>
  ),
  discover: (
    <svg viewBox="0 0 20 20" shapeRendering="crispEdges"><circle cx="8.5" cy="8.5" r="5" fill="#4FD8E0" {...stroke} />
      <path d="M12 12l5 5" stroke="#000" strokeWidth="2.4" /></svg>
  ),
  learning: (
    <svg viewBox="0 0 20 20" shapeRendering="crispEdges"><rect x="3" y="11" width="3" height="6" fill="#14D99A" {...stroke} />
      <rect x="8.5" y="7" width="3" height="10" fill="#FFD21F" {...stroke} /><rect x="14" y="3" width="3" height="14" fill="#FF3D8B" {...stroke} /></svg>
  ),
};
