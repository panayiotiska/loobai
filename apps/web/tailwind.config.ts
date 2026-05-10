import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['var(--font-mono)', 'monospace'],
      },
      colors: {
        lab: {
          bg: '#1a1a2e',
          floor: '#2d2d44',
          wall: '#16213e',
          accent: '#0f3460',
          glow: '#e94560',
          text: '#c8d8e8',
          dim: '#7a8fa6',
        },
      },
    },
  },
  plugins: [],
};

export default config;
