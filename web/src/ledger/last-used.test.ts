// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'vitest';
import { clearCache } from '../offline/cache';
import { MAX_RECENT_CATEGORIES, lastUsed, recentCategoryIds, rememberUsed } from './last-used';

// What a person used last on this device, offered first in Add: the account and each kind's
// category (as before), and now each kind's recent categories, newest first, for the
// "Recent categories" chips (digest 4.8). Only ids, per person, let go on signing out.

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const WALLET = 'a'.repeat(16);
const cat = (n: number) => n.toString(16).padStart(16, 'c');

const spend = (email: string, categoryId: string) =>
  rememberUsed(email, { accountId: WALLET, kind: 'expense', categoryId });

beforeEach(async () => {
  await clearCache();
  localStorage.clear();
});

describe('recent categories', () => {
  test('are none before anything is used', () => {
    expect(recentCategoryIds(ME, 'expense')).toEqual([]);
    expect(recentCategoryIds(null, 'expense')).toEqual([]);
  });

  test('are each kind’s categories used, newest first, each once', () => {
    spend(ME, cat(1));
    spend(ME, cat(2));
    spend(ME, cat(1));
    rememberUsed(ME, { accountId: WALLET, kind: 'income', categoryId: cat(9) });
    expect(recentCategoryIds(ME, 'expense')).toEqual([cat(1), cat(2)]);
    expect(recentCategoryIds(ME, 'income')).toEqual([cat(9)]);
  });

  test(`keep the latest ${MAX_RECENT_CATEGORIES} of a kind`, () => {
    expect(MAX_RECENT_CATEGORIES).toBe(5);
    for (let n = 1; n <= 7; n++) spend(ME, cat(n));
    expect(recentCategoryIds(ME, 'expense')).toEqual([cat(7), cat(6), cat(5), cat(4), cat(3)]);
  });

  test('a transfer leaves them as they were', () => {
    spend(ME, cat(1));
    rememberUsed(ME, { toAccountId: WALLET });
    expect(recentCategoryIds(ME, 'expense')).toEqual([cat(1)]);
  });

  test('the category used last is still the newest, as before', () => {
    spend(ME, cat(1));
    spend(ME, cat(2));
    expect(lastUsed(ME).categoryIds.expense).toBe(cat(2));
    expect(lastUsed(ME).accountId).toBe(WALLET);
  });

  test('are kept per person', () => {
    spend(ME, cat(1));
    spend(OTHER, cat(2));
    expect(recentCategoryIds(ME, 'expense')).toEqual([cat(1)]);
    expect(recentCategoryIds(OTHER, 'expense')).toEqual([cat(2)]);
  });

  test('read what was kept before they existed as none, keeping the rest', () => {
    localStorage.setItem(
      `mahnee:lastUsed:${ME}`,
      JSON.stringify({ accountId: WALLET, categoryIds: { expense: cat(3) }, toAccountId: null }),
    );
    expect(recentCategoryIds(ME, 'expense')).toEqual([]);
    expect(lastUsed(ME).categoryIds.expense).toBe(cat(3));
    spend(ME, cat(4));
    expect(recentCategoryIds(ME, 'expense')).toEqual([cat(4)]);
  });

  test('pass over anything kept that is not a list of ids', () => {
    localStorage.setItem(
      `mahnee:lastUsed:${ME}`,
      JSON.stringify({ recent: { expense: [cat(1), 7, null, cat(1), cat(2)], income: 'x' } }),
    );
    expect(recentCategoryIds(ME, 'expense')).toEqual([cat(1), cat(2)]);
    expect(recentCategoryIds(ME, 'income')).toEqual([]);
  });

  test('are let go on signing out', async () => {
    spend(ME, cat(1));
    await clearCache();
    expect(recentCategoryIds(ME, 'expense')).toEqual([]);
  });
});
