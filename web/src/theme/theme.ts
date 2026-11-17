import type { CSSVariablesResolver } from '@mantine/core';
import { createTheme } from '@mantine/core';
import type { Accent } from '@shared/api';
import { ACCENT_RAMPS, ACCENT_SHADE } from '@shared/accents';

// "Paper ledger" dark neutrals (tokens.css), laid out the way Mantine reads them: text at
// 0, the page at 7 and raised surfaces at 6
const dark = [
  '#edece7',
  '#c2c1bb',
  '#96958f',
  '#66665f',
  '#3a3b41',
  '#2a2b30',
  '#18191c',
  '#0f1012',
  '#0a0b0c',
  '#050506',
] as const;

const FONT = "Geist, 'Helvetica Neue', Arial, sans-serif";

// The accent chosen in Look and start (cobalt until another is) is Mantine's primary colour
export const buildTheme = (accent: Accent = 'cobalt') =>
  createTheme({
    fontFamily: FONT,
    fontFamilyMonospace: "'Geist Mono', monospace",
    headings: { fontFamily: FONT, fontWeight: '600' },
    defaultRadius: 'md',
    radius: { xs: '4px', sm: '6px', md: '12px', lg: '18px', xl: '26px' },
    colors: { dark: [...dark], accent: [...ACCENT_RAMPS[accent]] },
    primaryColor: 'accent',
    primaryShade: { ...ACCENT_SHADE },
    cursorType: 'pointer',
    components: {
      // Spelled out so the filled primary style in tokens.css can find them
      Button: { defaultProps: { variant: 'filled' } },
      // Helper text sits under the field, as in the design
      TextInput: {
        defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] },
      },
      Select: { defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] } },
      Autocomplete: {
        defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] },
      },
      NumberInput: {
        defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] },
      },
      SegmentedControl: { defaultProps: { withItemsBorders: false, radius: 'xl' } },
      ActionIcon: { defaultProps: { variant: 'filled' } },
      Paper: { defaultProps: { bg: 'var(--surface)' } },
      // The scrim behind a sheet or dialog
      Modal: {
        defaultProps: { radius: 'lg', overlayProps: { backgroundOpacity: 0.38, color: '#0f1012' } },
        styles: {
          content: { background: 'var(--surface)' },
          header: { background: 'var(--surface)' },
        },
      },
      Drawer: {
        defaultProps: { overlayProps: { backgroundOpacity: 0.38, color: '#0f1012' } },
        styles: {
          content: { background: 'var(--surface)' },
          header: { background: 'var(--surface)' },
        },
      },
    },
  });

// Mantine's page, text and edge colours follow the tokens in tokens.css
const followTokens = {
  '--mantine-color-body': 'var(--ground)',
  '--mantine-color-text': 'var(--ink)',
  '--mantine-color-dimmed': 'var(--ink-3)',
  '--mantine-color-default-border': 'var(--line-2)',
};
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  dark: followTokens,
  light: followTokens,
});
