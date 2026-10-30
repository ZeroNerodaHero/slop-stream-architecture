import type { Config } from 'tailwindcss';

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
        decrease: 'rgb(var(--decrease) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
} satisfies Config;
