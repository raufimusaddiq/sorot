import type { Metadata } from 'next';
import './globals.css';

const description = 'Sorot cuts long Indonesian podcasts into ranked vertical clips with word-timed captions, on your own computer. Free and open source.';

export const metadata: Metadata = {
  // Absolute base for the Open Graph image; set NEXT_PUBLIC_SITE_URL where Sorot is hosted publicly.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:8080'),
  title: { default: 'Sorot: 90 minutes in, 40 seconds out', template: '%s · Sorot' },
  description,
  applicationName: 'Sorot',
  openGraph: {
    type: 'website',
    siteName: 'Sorot',
    title: 'Sorot: 90 minutes in, 40 seconds out',
    description,
  },
  twitter: { card: 'summary_large_image', title: 'Sorot: 90 minutes in, 40 seconds out', description },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Fonts (IBM Plex Mono, Pixelify Sans, Archivo) load via a Google Fonts
  // @import in globals.css, which also declares the --font-* variables
  // tailwind.config.js points at. The tab icon and Open Graph image are
  // Next file conventions: app/icon.svg, app/apple-icon.png, app/opengraph-image.png.
  return (
    <html lang="id">
      <body className="min-h-screen bg-bg text-fg antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
