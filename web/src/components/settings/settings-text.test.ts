import { describe, expect, test } from 'vitest';
import type { Category, ImportRecord, Settings } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import {
  addingSummary,
  budgetsSummary,
  categoriesSummary,
  importLine,
  importsSummary,
  lookSummary,
  moneySummary,
  savedText,
} from './settings-text';

// What the Settings index says under each section (R-Settings), worked out from the
// person's settings, categories and imports, and how a recent import reads (R-Set-Data,
// R-Desk-Data).

const with_ = (more: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...more });

describe('section summaries', () => {
  test('read as the design draws them with every setting at its default', () => {
    expect(moneySummary(DEFAULT_SETTINGS)).toBe('MYR · month from the 1st');
    expect(addingSummary(DEFAULT_SETTINGS)).toBe('Amount first · suggestions on');
    expect(lookSummary(DEFAULT_SETTINGS)).toBe('Match phone · opens on Home');
    expect(budgetsSummary(DEFAULT_SETTINGS)).toBe('Carry over on · daily at 9:00 PM');
  });

  test.each([
    [2, 'MYR · month from the 2nd'],
    [3, 'MYR · month from the 3rd'],
    [11, 'MYR · month from the 11th'],
    [12, 'MYR · month from the 12th'],
    [13, 'MYR · month from the 13th'],
    [21, 'MYR · month from the 21st'],
    [22, 'MYR · month from the 22nd'],
    [23, 'MYR · month from the 23rd'],
    [25, 'MYR · month from the 25th'],
    [31, 'MYR · month from the last day'],
  ])('a month from day %i reads "%s"', (day, text) => {
    expect(moneySummary(with_({ monthStartDay: day }))).toBe(text);
  });

  test('a month from payday says so', () => {
    expect(
      moneySummary(
        with_({ monthStartMode: 'payday', monthStartDay: 25, monthStartPayId: 'a'.repeat(16) }),
      ),
    ).toBe('MYR · month from payday');
  });

  test('follow each setting they name', () => {
    expect(addingSummary(with_({ startWith: 'category', suggestAsYouType: false }))).toBe(
      'Category first · suggestions off',
    );
    expect(lookSummary(with_({ theme: 'dark', startScreen: 'activity' }))).toBe(
      'Dark · opens on Activity',
    );
    expect(lookSummary(with_({ theme: 'light', startScreen: 'plan' }))).toBe(
      'Light · opens on Plan',
    );
    expect(budgetsSummary(with_({ carryOverDefault: false, reminderTime: '08:05' }))).toBe(
      'Carry over off · daily at 8:05 AM',
    );
    expect(budgetsSummary(with_({ reminderTime: '00:00' }))).toBe(
      'Carry over on · daily at 12:00 AM',
    );
    expect(budgetsSummary(with_({ reminderTime: '12:30' }))).toBe(
      'Carry over on · daily at 12:30 PM',
    );
    expect(budgetsSummary(with_({ dailyReminder: false }))).toBe(
      'Carry over on · no daily reminder',
    );
  });
});

describe('the categories summary', () => {
  const defaults = DEFAULT_CATEGORIES.map((c): Category => ({ ...c }));

  test('counts the top-level ones in use, of each kind', () => {
    expect(categoriesSummary(defaults)).toBe('8 expense, 2 income');
  });

  test('leaves out subcategories and archived ones', () => {
    const food = defaults.find((c) => c.name === 'Food')!;
    const salary = defaults.find((c) => c.name === 'Salary')!;
    const more: Category[] = [
      {
        id: 'e'.repeat(16),
        name: 'Coffee',
        kind: 'expense',
        parentId: food.id,
        position: 0,
        archived: false,
      },
      {
        id: 'f'.repeat(16),
        name: 'Freelance',
        kind: 'income',
        parentId: null,
        position: 9,
        archived: false,
      },
    ];
    const archived = defaults.map((c) => (c.id === salary.id ? { ...c, archived: true } : c));
    expect(categoriesSummary([...archived, ...more])).toBe('8 expense, 2 income');
  });

  test('says one of a kind as one', () => {
    const one = defaults.filter((c) => c.name === 'Food' || c.name === 'Salary');
    expect(categoriesSummary(one)).toBe('1 expense, 1 income');
  });
});

describe('imports', () => {
  const NOW = new Date(2026, 10, 10, 12).getTime();
  const record = (more: Partial<ImportRecord>): ImportRecord => ({
    id: 'a'.repeat(16),
    fileName: 'maybank-oct.csv',
    accountId: 'b'.repeat(16),
    addedCount: 38,
    skippedCount: 0,
    createdAt: new Date(2026, 10, 2, 9).getTime(),
    ...more,
  });

  test('the index says when the last one was, or that there were none', () => {
    expect(importsSummary([record({})], NOW)).toBe('Last import Nov 2');
    expect(importsSummary([record({ createdAt: new Date(2025, 9, 4).getTime() })], NOW)).toBe(
      'Last import Oct 4, 2025',
    );
    expect(importsSummary([], NOW)).toBe('No imports yet');
  });

  test('a recent one reads its day, the account it went into and how many were added', () => {
    expect(importLine(record({}), 'Maybank Savings', NOW)).toEqual({
      line: 'Nov 2 · into Maybank Savings · 38 added',
      where: 'Nov 2 · into Maybank Savings',
      counts: '38 added',
    });
    expect(importLine(record({ skippedCount: 4 }), 'Maybank Savings', NOW)).toEqual({
      line: 'Nov 2 · into Maybank Savings · 38 added',
      where: 'Nov 2 · into Maybank Savings',
      counts: '38 added, 4 skipped',
    });
  });

  test('one from another year names the year', () => {
    expect(
      importLine(record({ createdAt: new Date(2025, 9, 4, 9).getTime() }), 'Visa', NOW).line,
    ).toBe('Oct 4, 2025 · into Visa · 38 added');
  });

  test('a Mahnee export went into no one account', () => {
    expect(importLine(record({ accountId: null, addedCount: 1 }), null, NOW)).toEqual({
      line: 'Nov 2 · 1 added',
      where: 'Nov 2',
      counts: '1 added',
    });
  });
});

// The message once a setting's save lands: what it's set to now, in the words its row uses
describe('what a saved setting says', () => {
  const profile = (more: Partial<Settings>, displayName: string | null = 'Ryan') => ({
    email: 'ryan@example.com',
    displayName,
    settings: with_(more),
    conversion: null,
    picture: null,
    googlePicture: false,
  });

  test.each<[Partial<Settings>, string]>([
    [{ accent: 'plum' }, 'Accent set to Plum'],
    [{ theme: 'dark' }, 'Theme set to Dark'],
    [{ suggestAsYouType: false }, 'Suggest as you type turned off'],
    [{ monthStartMode: 'date', monthStartDay: 25 }, 'Month starts on the 25th'],
    [{ weekStart: 'sunday' }, 'Week starts on Sunday'],
    [{ reminderTime: '07:30' }, 'Reminder set for 7:30 AM'],
    [{ otherCurrencies: ['USD', 'SGD'] }, 'Other currencies set to USD, SGD'],
  ])('%j says "%s"', (settings, said) => {
    expect(savedText({ settings }, profile(settings))).toBe(said);
  });

  test('a name says it, and an empty one the email it goes back to', () => {
    expect(savedText({ displayName: 'Mei' }, profile({}, 'Mei'))).toBe('Name set to Mei');
    expect(savedText({ displayName: null }, profile({}, null))).toBe('Name set to ryan');
  });

  test('several settings say nothing of their own, for "Settings saved"', () => {
    expect(savedText({ settings: { accent: 'plum', theme: 'dark' } }, profile({}))).toBeNull();
    expect(savedText({ displayName: 'Mei', settings: { theme: 'dark' } }, profile({}))).toBeNull();
  });
});
