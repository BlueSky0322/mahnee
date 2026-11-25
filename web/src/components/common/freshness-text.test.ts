import { describe, expect, test } from 'vitest';
import { ageInWords, freshnessText } from './freshness-text';

// What the freshness label says, worked out from the connection, the changes waiting and
// when the server last confirmed the figures shown

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;
const NOW = new Date(2026, 10, 10, 9, 0).getTime();

describe('how old a copy is, in words', () => {
  test.each([
    [0, 'less than a minute'],
    [59 * S + 999, 'less than a minute'],
    [MIN, '1 min'],
    [5 * MIN + 59 * S, '5 min'],
    [59 * MIN + 59 * S + 999, '59 min'],
    [H, '1 h'],
    [3 * H + 59 * MIN, '3 h'],
    [23 * H + 59 * MIN + 59 * S, '23 h'],
    [D, '1 d'],
    [2 * D + 5 * H, '2 d'],
    // A clock set back reads as just now, never a negative age
    [-5 * MIN, 'less than a minute'],
  ])('%i ms reads "%s"', (ms, words) => {
    expect(ageInWords(ms)).toBe(words);
  });
});

describe('the label', () => {
  const base = { online: true, waiting: 0, signedOut: false, at: null as number | null, now: NOW };
  const upToDate = {
    text: 'Up to date',
    short: 'Up to date',
    tone: 'fresh',
    icon: 'check',
    say: null,
  };
  const saving = { text: 'Saving', short: 'Saving', tone: 'quiet', icon: 'up', say: null };
  const saved = { text: 'Saved', short: 'Saved', tone: 'fresh', icon: 'check', say: null };
  const fromDevice = (text: string, short: string) => ({
    text,
    short,
    tone: 'old',
    icon: 'slash',
    say: 'Showing what this device kept, not yet checked with the server.',
  });

  // Each says it in full, and in a few words (`short`) for narrow places, the sidebar
  test.each([
    ['fresh, nothing waiting', {}, upToDate],
    ['from the device', { at: NOW - 2 * H }, fromDevice('From this device, 2 h old', '2 h old')],
    // The age keeps counting on screen, but what's announced stays the same
    [
      'from the device, older',
      { at: NOW - 3 * H },
      fromDevice('From this device, 3 h old', '3 h old'),
    ],
    ['from the device, its time unknown', { at: 0 }, fromDevice('From this device', 'Device copy')],
    // A save on its way says nothing until it has taken a moment, then just "Saving"
    ['saving one, not yet a moment', { waiting: 1 }, upToDate],
    ['saving one', { waiting: 1, savingShown: true }, saving],
    ['saving two, without the count', { waiting: 2, savingShown: true }, saving],
    ['saved just now', { justSaved: true }, saved],
    // Another save starting just after keeps "Saved" until it has taken a moment too
    ['saved just now, another on its way', { waiting: 1, justSaved: true }, saved],
    [
      'saved just now, another taking a while',
      { waiting: 1, justSaved: true, savingShown: true },
      saving,
    ],
    // Nothing can be sending while the server doesn't answer: the figures are the device's
    [
      'waiting, figures from the device',
      { waiting: 1, at: NOW - 2 * H, savingShown: true },
      fromDevice('From this device, 2 h old', '2 h old'),
    ],
    [
      'signed out, one waiting',
      { signedOut: true, waiting: 1 },
      {
        text: 'Signed out · 1 change waiting',
        short: '1 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Signed out, 1 change waiting to save.',
      },
    ],
    [
      'signed out, two waiting',
      { signedOut: true, waiting: 2, savingShown: true, justSaved: true },
      {
        text: 'Signed out · 2 changes waiting',
        short: '2 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Signed out, 2 changes waiting to save.',
      },
    ],
    [
      'offline, one waiting',
      { online: false, waiting: 1 },
      {
        text: 'Offline · 1 change waiting',
        short: '1 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Offline, 1 change waiting to save.',
      },
    ],
    [
      'offline, twelve waiting',
      { online: false, waiting: 12, savingShown: true },
      {
        text: 'Offline · 12 changes waiting',
        short: '12 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Offline, 12 changes waiting to save.',
      },
    ],
    [
      'offline, waiting, figures from the device',
      { online: false, waiting: 1, at: NOW - 2 * H },
      {
        text: 'Offline · 1 change waiting',
        short: '1 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Offline, 1 change waiting to save.',
      },
    ],
    [
      'offline, signed out, waiting',
      { online: false, waiting: 1, signedOut: true },
      {
        text: 'Offline · 1 change waiting',
        short: '1 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Offline, 1 change waiting to save.',
      },
    ],
    [
      'offline, nothing waiting, figures from the device',
      { online: false, at: NOW - 2 * H },
      fromDevice('From this device, 2 h old', '2 h old'),
    ],
    [
      'offline, nothing waiting, figures fetched before',
      { online: false, justSaved: true },
      { text: 'Offline', short: 'Offline', tone: 'old', icon: 'slash', say: 'Offline.' },
    ],
    // Amounts converting into a new home currency: changes wait until it's done. It's
    // under way, not a problem, so it isn't announced as it counts up.
    [
      'converting',
      { convertingTo: 'USD' },
      { text: 'Converting to USD…', short: 'USD…', tone: 'old', icon: 'up', say: null },
    ],
    // Saved once it's done, so how many wait is said with it
    [
      'converting, changes waiting',
      { convertingTo: 'USD', waiting: 2, savingShown: true },
      {
        text: 'Converting to USD… · 2 changes waiting',
        short: 'USD…',
        tone: 'old',
        icon: 'up',
        say: null,
      },
    ],
    [
      'converting, how far it has got, one change waiting',
      { convertingTo: 'USD', convertedPercent: 40, waiting: 1 },
      {
        text: 'Converting to USD… 40% · 1 change waiting',
        short: 'USD 40%',
        tone: 'old',
        icon: 'up',
        say: null,
      },
    ],
    [
      'converting, how far it has got, three changes waiting',
      { convertingTo: 'USD', convertedPercent: 40, waiting: 3 },
      {
        text: 'Converting to USD… 40% · 3 changes waiting',
        short: 'USD 40%',
        tone: 'old',
        icon: 'up',
        say: null,
      },
    ],
    [
      'converting, offline with changes',
      { convertingTo: 'USD', online: false, waiting: 1 },
      {
        text: 'Offline · 1 change waiting',
        short: '1 waiting',
        tone: 'old',
        icon: 'slash',
        say: 'Offline, 1 change waiting to save.',
      },
    ],
  ] as const)('%s', (_, state, label) => {
    expect(freshnessText({ ...base, ...state })).toEqual(label);
  });
});
