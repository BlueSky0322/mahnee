import type { CSSVariablesResolver } from '@mantine/core';
import { createTheme } from '@mantine/core';
import { ACCENT_RAMPS, ACCENT_SHADE } from '@shared/accents';
import type { Accent } from '@shared/api';

// Nocturne neutrals, laid out the way Mantine reads them: text at 0, the page at 7
// and raised surfaces at 6
const dark = [
  '#e9e9ed',
  '#cfd3e5',
  '#9397ab',
  '#75798c',
  '#3f424d',
  '#2d2f3c',
  '#232532',
  '#161826',
  '#11131e',
  '#0b0c14',
] as const;

export const buildTheme = (accent: Accent) =>
  createTheme({
    fontFamily: 'Inter, system-ui, sans-serif',
    headings: { fontFamily: 'Inter, system-ui, sans-serif', fontWeight: '500' },
    defaultRadius: 'md',
    radius: { xs: '4px', sm: '6px', md: '8px', lg: '14px', xl: '22px' },
    colors: { dark: [...dark], accent: ACCENT_RAMPS[accent].ramp },
    primaryColor: 'accent',
    primaryShade: { ...ACCENT_SHADE },
    cursorType: 'pointer',
    components: {
      // Spelled out so the outlined primary style in tokens.css can find them
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
      SegmentedControl: { defaultProps: { withItemsBorders: true, radius: 'md' } },
      ActionIcon: { defaultProps: { variant: 'filled' } },
      Paper: { defaultProps: { bg: 'var(--sf-surface)' } },
      Modal: {
        defaultProps: { radius: 'lg', overlayProps: { backgroundOpacity: 0.6, color: '#292b31' } },
        styles: {
          content: { background: 'var(--sf-surface)' },
          header: { background: 'var(--sf-surface)' },
        },
      },
      Drawer: {
        defaultProps: { overlayProps: { backgroundOpacity: 0.6, color: '#292b31' } },
        styles: {
          content: { background: 'var(--sf-surface)' },
          header: { background: 'var(--sf-surface)' },
        },
      },
    },
  });

// Mantine's page and text colours follow the Nocturne tokens in tokens.css
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  dark: {
    '--mantine-color-body': 'var(--sf-bg)',
    '--mantine-color-text': 'var(--sf-text)',
    '--mantine-color-dimmed': 'var(--sf-text-muted)',
    '--mantine-color-default-border': 'var(--sf-border)',
  },
  light: {
    '--mantine-color-body': 'var(--sf-bg)',
    '--mantine-color-text': 'var(--sf-text)',
    '--mantine-color-dimmed': 'var(--sf-text-muted)',
    '--mantine-color-default-border': 'var(--sf-border)',
  },
});
