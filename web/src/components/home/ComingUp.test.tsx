// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import ComingUp, { type ComingUpRow } from './ComingUp';

// Home's Coming up (R-Desk-Home): the next scheduled items, each with its amount and day,
// and the shapes Scheduled fills in later (amounts to check, what was added this month on
// its own), drawn here from fixed rows.

afterEach(cleanup);

const ROWS: ComingUpRow[] = [
  {
    id: 'a'.repeat(16),
    name: 'TNB electricity',
    kind: 'expense',
    amountCents: 18_900,
    date: '2026-11-20',
    where: 'Maybank Savings',
    toCheck: true,
  },
  {
    id: 'b'.repeat(16),
    name: 'Salary',
    kind: 'income',
    amountCents: 680_000,
    date: '2026-11-25',
    where: 'Maybank Savings',
    toCheck: false,
  },
  {
    id: 'c'.repeat(16),
    name: 'Rent',
    kind: 'expense',
    amountCents: 120_000,
    date: '2026-12-01',
    where: 'Maybank Savings',
    toCheck: false,
  },
];

/** What an element says, each piece of text on its own separated by a space */
function text(el: HTMLElement) {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const words = node.textContent?.replace(/\s+/g, ' ').trim();
    if (words) parts.push(words);
  }
  return parts.join(' ');
}

/** Each row of the list inside Coming up, as it reads */
const rowTexts = () =>
  within(within(screen.getByRole('region', { name: 'Coming up' })).getByRole('list'))
    .getAllByRole('listitem')
    .map(text);

describe('Coming up', () => {
  test('lists each item with its amount, its day and its account, income signed', () => {
    render(
      <ComingUp
        rows={ROWS}
        added={[]}
      />,
    );
    const card = within(screen.getByRole('region', { name: 'Coming up' }));
    expect(card.getByRole('link', { name: 'All scheduled' }).getAttribute('href')).toBe(
      '?plan=scheduled',
    );
    expect(rowTexts()).toEqual([
      'TNB electricity · RM 189.00 Nov 20 · amount to check',
      'Salary · +RM 6,800.00 Nov 25 · Maybank Savings',
      'Rent · RM 1,200.00 Dec 1 · Maybank Savings',
    ]);
    expect(screen.queryByText(/^Added this month/)).toBeNull();
  });

  test('says what was added this month on its own, when anything was', () => {
    render(
      <ComingUp
        rows={ROWS.slice(1)}
        added={['Rent', 'Netflix']}
      />,
    );
    expect(screen.getByText('Added this month: Rent, Netflix')).toBeTruthy();
    expect(screen.queryByText(/amount to check/)).toBeNull();
  });
});
