import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sorot',
  description: 'Long videos → vertical clips with word-timed captions, for Indonesian short-form',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Geist fonts are loaded via Google Fonts CSS @import in globals.css —
  // Next 14.2 doesn't ship Geist in next/font/google yet, and adding the
  // geist npm package would require a Docker rebuild. The CSS-variable
  // indirection (--font-sans / --font-mono) that tailwind.config.js expects
  // is declared in globals.css.
  return (
    <html lang="id">
      <body className="min-h-screen bg-bg text-fg antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
