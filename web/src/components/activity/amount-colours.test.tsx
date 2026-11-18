// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';
import { TOKENS, addStyles, moduleCss, readBeside, textColour, tokensCss } from '../../testing/css';
import activityCss from './Activity.module.css';

// R-System's "Amounts say which way", on Activity: spending in ink with a minus, income
// green with a plus, a transfer grey with no sign ("not an expense"), in the light theme
// through Activity's own stylesheet and the app's tokens. (The sweep checks dark, in a
// real browser.)

setupAppTests();

const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  const remove = addStyles([
    tokensCss(),
    moduleCss(readBeside('./Activity.module.css', import.meta.url), activityCss),
  ]);
  return () => {
    remove();
    vi.useRealTimers();
  };
});

function withEach() {
  const server = fakeServer();
  for (const [i, account] of [WALLET, BANK].entries()) {
    server.accounts.push({
      id: account,
      name: ['Wallet', 'Bank'][i],
      kind: 'cash',
      currency: 'MYR',
      openingCents: 0,
      position: i,
      archived: false,
    });
  }
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const base = { toAccountId: null, note: null, date: '2026-11-09', accountId: WALLET };
  server.transactions.push(
    {
      ...base,
      id: '1'.padStart(16, 'd'),
      kind: 'expense',
      amountCents: 725,
      categoryId: id('Food'),
      payee: 'Kiosk',
      createdAt: 1,
    },
    {
      ...base,
      id: '2'.padStart(16, 'd'),
      kind: 'income',
      amountCents: 325_000,
      categoryId: id('Salary'),
      payee: 'Acme',
      createdAt: 2,
    },
    {
      ...base,
      id: '3'.padStart(16, 'd'),
      kind: 'transfer',
      accountId: BANK,
      toAccountId: WALLET,
      amountCents: 7_500,
      categoryId: null,
      payee: 'Top-up',
      createdAt: 3,
    },
  );
  return server;
}

describe.each(['phone', 'desktop'] as const)('amounts on Activity (%s)', (size) => {
  test('spending ink, income green, a transfer grey', async () => {
    // Every kind, so the transfer is listed beside them
    renderApp(withEach(), '/?activity&kind=all', { size });
    const colourOf = async (text: string) =>
      textColour(
        await within(await screen.findByRole('region', { name: 'Results' })).findByText(text),
      );
    expect(await colourOf('−7.25')).toBe(TOKENS.light['--ink']);
    expect(await colourOf('+3,250.00')).toBe(TOKENS.light['--pos']);
    expect(await colourOf('75.00')).toBe(TOKENS.light['--ink-3']);
  });
});
