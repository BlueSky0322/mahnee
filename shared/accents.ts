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
 * The "Paper ledger" cobalt, which the app draws in whatever accent is saved until the
 * accent setting is rebuilt: #2d4bd8 on the light theme and #93a5ff on the dark one, at
 * the shades ACCENT_SHADE names
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

/** Which shade of a ramp is the accent on each theme */
export const ACCENT_SHADE = { dark: 4, light: 6 } as const;

export const isAccent = (value: unknown): value is Accent =>
  (ACCENTS as readonly unknown[]).includes(value);
