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

/**
 * The "Paper ledger" cobalt, the accent before any other is chosen: #2d4bd8 on the light
 * theme and #93a5ff on the dark one, at the shades ACCENT_SHADE names
 */
export const COBALT_RAMP: AccentRamp = [
  '#eef1fd',
  '#e7ebfb',
  '#c9d2f8',
  '#aebcfc',
  '#93a5ff',
  '#5a74e6',
  '#2d4bd8',
  '#233bab',
  '#1f2440',
  '#141833',
];

/**
 * Each accent Look and start offers (R-Set-Look), as a ramp: the light theme's accent is
 * the design's swatch (shade 6). The boards give a dark shade for cobalt only; the others'
 * dark shades (4) and every tint (1 light, 8 dark) are worked out here, each tint keeping
 * the accent's own words on it at 4.5:1 or more.
 */
export const ACCENT_RAMPS: Record<Accent, AccentRamp> = {
  cobalt: COBALT_RAMP,
  green: [
    '#f6faf8',
    '#eaf3ef',
    '#bbd7cb',
    '#8dbca8',
    '#6cc59a',
    '#44a076',
    '#1b7a52',
    '#166242',
    '#253530',
    '#182220',
  ],
  plum: [
    '#faf7fb',
    '#f4edf5',
    '#dcc4dd',
    '#c49ec7',
    '#d494d8',
    '#af68b4',
    '#8a3c8f',
    '#6e3072',
    '#362d3a',
    '#231d26',
  ],
  rust: [
    '#fcf8f6',
    '#f8efeb',
    '#e7c9bb',
    '#d8a48e',
    '#f0956a',
    '#d07043',
    '#b04a1c',
    '#8d3b16',
    '#3b2d28',
    '#261d1b',
  ],
  graphite: [
    '#f7f7f8',
    '#eeeeef',
    '#c5c6c8',
    '#9fa0a4',
    '#c4c6cd',
    '#82848a',
    '#3f4248',
    '#32353a',
    '#343538',
    '#212225',
  ],
};

/** Each accent's name, as its swatch is named */
export const ACCENT_NAMES: Record<Accent, string> = {
  cobalt: 'Cobalt',
  green: 'Green',
  plum: 'Plum',
  rust: 'Rust',
  graphite: 'Graphite',
};

/** Which shade of a ramp is the tint on each theme: a picked chip, the New tag */
export const TINT_SHADE = { dark: 8, light: 1 } as const;

/** Which shade of a ramp is the accent on each theme */
export const ACCENT_SHADE = { dark: 4, light: 6 } as const;

export const isAccent = (value: unknown): value is Accent =>
  (ACCENTS as readonly unknown[]).includes(value);
