import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        panel: '0 10px 40px -20px rgba(15, 23, 42, 0.35)',
      },
      colors: {
        surface: '#0b1220',
        panel: '#111827',
        muted: '#94a3b8',
        accent: '#38bdf8',
      },
    },
  },
  plugins: [],
} satisfies Config;
