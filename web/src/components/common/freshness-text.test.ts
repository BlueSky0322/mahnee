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

  test.each([
    ['fresh, nothing waiting', {}, 'Up to date', true],
    ['from the device', { at: NOW - 2 * H }, 'From this device, 2 h old', false],
    ['from the device, its time unknown', { at: 0 }, 'From this device', false],
    ['saving one', { waiting: 1 }, 'Saving 1 change', false],
    ['saving two', { waiting: 2 }, 'Saving 2 changes', false],
    // Nothing can be sending while the server doesn't answer: the figures are the device's
    [
      'waiting, figures from the device',
      { waiting: 1, at: NOW - 2 * H },
      'From this device, 2 h old',
      false,
    ],
    [
      'signed out, one waiting',
      { signedOut: true, waiting: 1 },
      'Signed out · 1 change waiting to save',
      false,
    ],
    [
      'signed out, two waiting',
      { signedOut: true, waiting: 2 },
      'Signed out · 2 changes waiting to save',
      false,
    ],
    [
      'offline, one waiting',
      { online: false, waiting: 1 },
      'Offline · 1 change waiting to save',
      false,
    ],
    [
      'offline, two waiting',
      { online: false, waiting: 2 },
      'Offline · 2 changes waiting to save',
      false,
    ],
    [
      'offline, waiting, figures from the device',
      { online: false, waiting: 1, at: NOW - 2 * H },
      'Offline · 1 change waiting to save',
      false,
    ],
    [
      'offline, signed out, waiting',
      { online: false, waiting: 1, signedOut: true },
      'Offline · 1 change waiting to save',
      false,
    ],
    [
      'offline, nothing waiting, figures from the device',
      { online: false, at: NOW - 2 * H },
      'From this device, 2 h old',
      false,
    ],
    ['offline, nothing waiting, figures fetched before', { online: false }, 'Offline', false],
  ])('%s', (_, state, text, fresh) => {
    expect(freshnessText({ ...base, ...state })).toEqual({ text, fresh });
  });
});
