import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

// The same token names as Axiom-Frontend, fed by the css variables in src/app/globals.css.
//
// Hard edges: the theme has no border radius at all (only `rounded-none` exists, so a stray
// `rounded-xl` produces no css) and no box shadow at all (an empty scale, so a stray `shadow-md`
// produces none either; .cursor/rules/no-box-shadow.mdc). A box is a 1px stroke.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    borderRadius: {
      none: '0px'
    },
    boxShadow: {},
    extend: {
      colors: {
        background: 'rgb(var(--background) / <alpha-value>)',
        backgroundSecondary: 'rgb(var(--background-secondary) / <alpha-value>)',
        backgroundTertiary: 'rgb(var(--background-tertiary) / <alpha-value>)',
        textPrimary: 'rgb(var(--text-primary) / <alpha-value>)',
        textSecondary: 'rgb(var(--text-secondary) / <alpha-value>)',
        textTertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
        primaryBlue: 'rgb(var(--primary-color) / <alpha-value>)',
        primaryBlueHover: 'rgb(var(--primary-color-hover) / <alpha-value>)',
        primaryStroke: 'rgb(var(--primary-stroke) / <alpha-value>)',
        secondaryStroke: 'rgb(var(--secondary-stroke) / <alpha-value>)',
        increase: 'rgb(var(--increase) / <alpha-value>)',
        decrease: 'rgb(var(--decrease) / <alpha-value>)',
        caution: 'rgb(var(--caution) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'system-ui', 'sans-serif']
      },
      // the chat's send button, when a line is refused for the rate: the countdown on it shakes
      // once. a refusal, not a press effect (buttons.mdc); `motion-safe:` keeps it off for anyone
      // who asked for less motion
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' }
        },
        // the red dot inside a streaming presence square (PresenceSquare.tsx): the dot breathes, the
        // square never moves. `motion-safe:` keeps it still for anyone who asked for less motion
        'presence-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.35', transform: 'scale(0.6)' }
        }
      },
      animation: {
        shake: 'shake 0.4s ease-in-out',
        'presence-pulse': 'presence-pulse 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: [
    // `beside:` is where a stream's chat column stands beside the video (ChatSlot.tsx). a page that
    // measures its own body says so on the box, `data-chat="beside"` or `"tabbed"` (WatchPage.tsx: the
    // sidebar takes width the viewport does not show); anywhere else it is the lg breakpoint
    plugin(({ addVariant }) => {
      addVariant('beside', ['@media (min-width: 1024px) { &:where(:not([data-chat] *, [data-chat])) }', '&:where([data-chat="beside"], [data-chat="beside"] *)']);
    })
  ]
} satisfies Config;
