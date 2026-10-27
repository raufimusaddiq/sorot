// A retro desktop window: striped title bar (its colour says which app it is)
// over a cream body. Purely presentational.

import type { ReactNode } from 'react';

export function Window({
  title, bar = 'bg-surface', right, className = '', bodyClassName = 'p-5', children,
}: {
  title: string;
  /** Title bar fill, e.g. bg-aqua. */
  bar?: string;
  /** Small text at the right end of the title bar (counts, status). */
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={`win ${className}`} aria-label={title}>
      <div className={`win-bar ${bar}`}>
        <span className="close" aria-hidden />
        <span className="stripes" aria-hidden />
        <span className="px-1 whitespace-nowrap">{title}</span>
        <span className="stripes" aria-hidden />
        {right !== undefined && <span className="text-[13px] whitespace-nowrap">{right}</span>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
