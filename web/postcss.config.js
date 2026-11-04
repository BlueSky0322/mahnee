import { fileURLToPath } from 'node:url';

export default {
  plugins: {
    'tailwindcss': { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    'autoprefixer': {},
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
};
