/** Sorot design tokens: retro desktop (Poolsuite) × neo-brutalism.
 *
 * Same token names the components already use, repainted:
 *
 *   bg          pink desktop (dotted in globals.css)
 *   surface     cream window body
 *   surface-2   white: inputs, nested panes
 *   surface-3   warm grey: idle buttons
 *   line        black: every border is ink
 *   fg / muted / subtle   ink, then two warm greys that still read on cream
 *   accent      signal blue: active states, links, selection
 *   accent-alt  lilac: LLM picks, secondary emphasis
 *   success / warning / error
 *               DEFAULT is dark enough for text on cream and for white text on a fill;
 *               `tint` is the loud sticker colour behind black text
 *   sun / hot / aqua / mint / tang / lilac
 *               window title bars, stickers, the primary button
 */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FF9EC0',
        surface: '#FBF3EA',
        'surface-2': '#FFFFFF',
        'surface-3': '#EFE4D6',
        line: '#000000',
        fg: '#000000',
        muted: '#4A4038',
        subtle: '#6E6259',
        accent: {
          DEFAULT: '#2F4BFF',
          soft: '#4A63FF',
          tint: '#DCE1FF',
        },
        'accent-alt': {
          DEFAULT: '#5B3FD6',
          soft: '#7A5FF0',
          tint: '#D9CCFF',
        },
        success: {
          DEFAULT: '#0A7F50',
          tint: '#9EF0C8',
        },
        warning: {
          DEFAULT: '#9A5300',
          tint: '#FFD21F',
        },
        error: {
          DEFAULT: '#C8102E',
          tint: '#FFB3C4',
        },
        sun: '#FFD21F',
        hot: '#FF3D8B',
        aqua: '#4FD8E0',
        mint: '#14D99A',
        tang: '#FF7A3D',
        lilac: '#A98BFF',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-monospace', 'monospace'],
        mono: ['var(--font-pixel)', 'ui-monospace', 'monospace'],
        pixel: ['var(--font-pixel)', 'ui-monospace', 'monospace'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      borderWidth: {
        DEFAULT: '2px',
        3: '3px',
      },
      borderRadius: {
        card: '0.5rem',
      },
      boxShadow: {
        // Hard offset shadows: no blur, ever.
        geist: '3px 3px 0 #000',
        'geist-md': '5px 5px 0 #000',
        hard: '6px 6px 0 #000',
        'hard-sm': '3px 3px 0 #000',
      },
    },
  },
  plugins: [],
};
