// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'vitest';
import { clearCache } from '../../offline/cache';
import type { AddDraft } from './add-draft';
import { dropDraft, keepDraft, readDraft } from './add-draft';

// What was typed in Add and closed without saving, kept on this device for the person
// who typed it, until it's saved or they sign out (digest 3.5, "Drafts kept on close").

const ME = 'me@example.com';
const OTHER = 'other@example.com';

const DRAFT: AddDraft = {
  kind: 'expense',
  expr: '3+4.25',
  accountId: 'a'.repeat(16),
  toAccountId: null,
  categoryId: 'c'.repeat(16),
  newCategory: null,
  payee: 'Refund',
  date: '2026-08-18',
  repeat: 'monthly',
};

beforeEach(async () => {
  await clearCache();
  localStorage.clear();
});

describe('a draft', () => {
  test('is read back as it was kept', () => {
    keepDraft(ME, DRAFT);
    expect(readDraft(ME)).toEqual(DRAFT);
  });

  test('keeps a category still to be made', () => {
    const draft: AddDraft = {
      ...DRAFT,
      categoryId: null,
      newCategory: { id: 'f'.repeat(16), name: 'Tea leaves', parentId: 'c'.repeat(16) },
    };
    keepDraft(ME, draft);
    expect(readDraft(ME)).toEqual(draft);
  });

  test('is each person’s own', () => {
    keepDraft(ME, DRAFT);
    expect(readDraft(OTHER)).toBeNull();
    expect(readDraft(null)).toBeNull();
    keepDraft(null, DRAFT);
    expect(readDraft(null)).toBeNull();
  });

  test('goes once dropped', () => {
    keepDraft(ME, DRAFT);
    dropDraft(ME);
    expect(readDraft(ME)).toBeNull();
  });

  test('goes on signing out', async () => {
    keepDraft(ME, DRAFT);
    await clearCache();
    expect(readDraft(ME)).toBeNull();
  });

  test('kept in a shape it can not read is no draft', () => {
    localStorage.setItem(`mahnee:addDraft:${ME}`, '{"kind":"loan","expr":7}');
    expect(readDraft(ME)).toBeNull();
    localStorage.setItem(`mahnee:addDraft:${ME}`, 'not json');
    expect(readDraft(ME)).toBeNull();
  });

  test('a sum the keypad would not take is no draft', () => {
    localStorage.setItem(`mahnee:addDraft:${ME}`, JSON.stringify({ ...DRAFT, expr: '1.234' }));
    expect(readDraft(ME)).toBeNull();
    // Past the largest amount
    localStorage.setItem(
      `mahnee:addDraft:${ME}`,
      JSON.stringify({ ...DRAFT, expr: '10000000.01' }),
    );
    expect(readDraft(ME)).toBeNull();
  });

  test('a day left as Today is kept as Today, not as the day it was typed on', () => {
    keepDraft(ME, { ...DRAFT, date: null });
    expect(readDraft(ME)?.date).toBeNull();
    keepDraft(ME, { ...DRAFT, date: '2000-01-01' });
    expect(readDraft(ME)?.date).toBe('2000-01-01');
  });

  test.each([
    ['a day that is no day', { date: '2026-13-40' }],
    ['a day before 2000', { date: '1999-12-31' }],
    ['a day still to come', { date: '2999-01-01' }],
    ['an unknown repeat', { repeat: 'yearly' }],
    ['a payee past 80 characters', { payee: 'x'.repeat(81) }],
    ['an account id that is not text', { accountId: 7 }],
    ['a category id that is not text', { categoryId: ['c'] }],
    ['an unknown kind', { kind: 'loan' }],
    [
      'a new category with no name',
      { newCategory: { id: 'f'.repeat(16), name: ' ', parentId: null } },
    ],
  ])('kept with %s is no draft', (_, bad) => {
    localStorage.setItem(`mahnee:addDraft:${ME}`, JSON.stringify({ ...DRAFT, ...bad }));
    expect(readDraft(ME)).toBeNull();
  });
});
