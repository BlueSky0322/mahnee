import { ACCENTS, type Accent } from './api';

/** Ten shades, light to dark, laid out as Mantine reads a colour */
export type AccentRamp = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

// The accent colours someone can pick in Settings. Each ramp is in OKLCH on the same
// lightness scale as the default blurple, so every accent reads the same. Shade 4 is
// the accent on the dark theme and shade 6 on the light one (ACCENT_SHADE): the app's
// theme and the Worker's consent page both draw it from here.
export const ACCENT_RAMPS = {
  blurple: {
    label: 'Blurple',
    ramp: [
      '#f5f4ff',
      '#e7e5fe',
      '#d2cefd',
      '#b5abfc',
      '#9184d9',
      '#796cbf',
      '#6a5db3',
      '#423a6a',
      '#2b2741',
      '#1a1828',
    ],
  },
  blue: {
    label: 'Blue',
    ramp: [
      '#eff6fe',
      '#d8ebff',
      '#b5d8fe',
      '#7dbdfe',
      '#5197db',
      '#387ec1',
      '#246cad',
      '#1c456b',
      '#182d42',
      '#101c28',
    ],
  },
  teal: {
    label: 'Teal',
    ramp: [
      '#ecf8f8',
      '#d3efee',
      '#a9e1e0',
      '#5dcccb',
      '#12a7a7',
      '#078c8c',
      '#047879',
      '#004d4d',
      '#0c3232',
      '#0a1e1e',
    ],
  },
  green: {
    label: 'Green',
    ramp: [
      '#eff8f1',
      '#daefdd',
      '#b8e0bf',
      '#82cb92',
      '#56a76a',
      '#3d8e53',
      '#287c42',
      '#1f4e2c',
      '#1a321f',
      '#111e13',
    ],
  },
  amber: {
    label: 'Amber',
    ramp: [
      '#fbf4eb',
      '#f5e6d1',
      '#edcfa7',
      '#e0ad63',
      '#ca933e',
      '#a36e09',
      '#8d5e05',
      '#5a3b05',
      '#38280f',
      '#22190b',
    ],
  },
  rose: {
    label: 'Rose',
    ramp: [
      '#fef2f3',
      '#ffdfe3',
      '#fdc3ca',
      '#f996a6',
      '#d46e80',
      '#b95569',
      '#a54358',
      '#672d38',
      '#402026',
      '#271417',
    ],
  },
} satisfies Record<Accent, { label: string; ramp: AccentRamp }>;

/** Which shade of a ramp is the accent on each theme */
export const ACCENT_SHADE = { dark: 4, light: 6 } as const;

export const isAccent = (value: unknown): value is Accent =>
  (ACCENTS as readonly unknown[]).includes(value);
