import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sorot',
  description: 'Long videos → vertical clips with word-timed captions, for Indonesian short-form',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Fonts (IBM Plex Mono, Pixelify Sans, Archivo) load via a Google Fonts
  // @import in globals.css, which also declares the --font-* variables
  // tailwind.config.js points at. The dotted desktop background lives there too.
  return (
    <html lang="id">
      <body className="min-h-screen bg-bg text-fg antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
