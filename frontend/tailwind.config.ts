import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    borderRadius: {
      none: '0px',
      panel: 'var(--r-panel)',
      control: 'var(--r-control)',
      bubble: 'var(--r-bubble)',
      'bubble-outer': 'var(--r-bubble-outer)',
      'bubble-join': 'var(--r-bubble-join)',
      avatar: 'var(--r-avatar)',
      card: 'var(--r-card)'
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
        increaseHover: 'color-mix(in srgb, rgb(var(--increase)) 85%, black)',
        decrease: 'rgb(var(--decrease) / <alpha-value>)',
        caution: 'rgb(var(--caution) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'system-ui', 'sans-serif']
      },
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' }
        },
        dot: {
          '0%, 60%, 100%': { opacity: '0.2' },
          '30%': { opacity: '1' }
        }
      },
      animation: {
        shake: 'shake 0.4s ease-in-out',
        dot: 'dot 1.2s ease-in-out infinite both'
      }
    }
  },
  plugins: [
    plugin(({ addVariant }) => {
      addVariant('soft', ':root[data-shape="soft"] &');
      addVariant('bubble', ':root[data-shape="bubble"] &');
      addVariant('beside', ['@media (min-width: 1024px) { &:where(:not([data-chat] *, [data-chat])) }', '&:where([data-chat="beside"], [data-chat="beside"] *)']);
    })
  ]
} satisfies Config;
