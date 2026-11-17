import { describe, expect, test } from 'vitest';
import type { SettingResult } from './settings-search';
import { searchSettings } from './settings-search';

// Searching settings (R-Set-Search, R-Desk-Set-Search): a static index of every setting,
// its section, its visible line and words a person might search for that aren't on it.
// A setting whose name holds the words comes first; then the others, each saying where
// the words were found, quoted.

/** A result as a person reads it: its name, then its section and the phrase quoted */
const read = (r: SettingResult) => [
  r.name,
  r.phrase == null ? r.sectionName : `${r.sectionName} · "${r.phrase}"`,
];

/** The part of the name, or of the quoted phrase, that's marked */
const marked = (r: SettingResult) =>
  (r.matched.in === 'name' ? r.name : r.phrase ?? '').slice(
    r.matched.start,
    r.matched.start + r.matched.length,
  );

describe('searching settings', () => {
  test('"month" finds the three the design draws, a name match first, in that order', () => {
    const found = searchSettings('month');
    expect(found.map(read)).toEqual([
      ['Month starts on', 'Money'],
      ['Main currency', 'Money · "the month end"'],
      ['Home shows', 'Look and start · "the month-end figure"'],
    ]);
    expect(found.map(marked)).toEqual(['Month', 'month', 'month']);
    expect(found.map((r) => r.section)).toEqual(['money', 'money', 'look']);
  });

  test('ignores case and the spaces around the words', () => {
    expect(searchSettings('  MONTH ').map(read)).toEqual(searchSettings('month').map(read));
  });

  test("a setting's visible line is searched too, quoted, after the names that match", () => {
    // "keypad" is on Start with's line alone, nowhere in its name or other words
    expect(searchSettings('keypad').map(read)).toEqual([
      ['Start with', 'Adding entries · "What the keypad asks for first"'],
    ]);
    expect(searchSettings('keypad').map(marked)).toEqual(['keypad']);
    // A name first, then two settings found by their lines, in the index's order
    expect(searchSettings('budgets').map(read)).toEqual([
      ['Carry over, for new budgets', 'Budgets and reminders'],
      ['Main currency', 'Money · "For totals and budgets"'],
      ['Month starts on', 'Money · "When budgets reset"'],
    ]);
  });

  test('finds a setting by a word that is nowhere on its page', () => {
    expect(searchSettings('dark').map(read)).toEqual([['Theme', 'Look and start · "dark mode"']]);
    expect(searchSettings('display name').map(read)).toEqual([
      ['Your name', 'My account · "display name"'],
    ]);
  });

  test('finds nothing for nothing typed, or for words no setting has', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('zebra')).toEqual([]);
  });

  test('leaves out other currencies, which this version does not offer', () => {
    expect(searchSettings('other currencies')).toEqual([]);
  });
});
