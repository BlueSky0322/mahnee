// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChangesBody, LedgerChange } from '@shared/api';
import type { FakeServer, Within } from '../../testing/app';
import { addButton, fakeServer, renderApp, resizeScreen, setupAppTests } from '../../testing/app';

// New entry keeps the payee and note separate.
// On a short phone the payee, recent categories, the day, Repeat and the note fold under
// Details, which says what they hold. The figures and names are made up.

setupAppTests();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 19, 10, 0));
});
afterEach(() => vi.useRealTimers());

const WALLET = 'a'.repeat(16);

function withWallet(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 7_000,
    position: 0,
    archived: false,
  });
  return server;
}

const sentChanges = (): LedgerChange[] =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await addButton());
  return within(await screen.findByRole('form', { name: 'Add a transaction' }));
}

async function tap(user: ReturnType<typeof userEvent.setup>, form: Within, keys: string) {
  const keypad = within(form.getByRole('group', { name: 'Keypad' }));
  for (const k of keys) await user.click(keypad.getByRole('button', { name: k }));
}

const added = () =>
  sentChanges().find(
    (c): c is Extract<LedgerChange, { op: 'addTransaction' }> => c.op === 'addTransaction',
  );

describe('the payee and the note', () => {
  test.each(['phone', 'desktop'] as const)(
    'the field for who was paid is labelled Payee, and the note is its own (%s)',
    async (size) => {
      renderApp(withWallet(), '/?accounts', { size });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const form = await openAdd(user);
      expect(form.queryByLabelText('Payee or note')).toBeNull();
      const payee = form.getByLabelText('Payee');
      expect(payee.getAttribute('placeholder')).toBe('Optional');
      await user.type(payee, 'Grab');
      // The note is one tap away, folded until wanted
      expect(form.queryByRole('textbox', { name: 'Note' })).toBeNull();
      const noteButton = form.getByRole('button', { name: 'Note' });
      expect(noteButton.getAttribute('aria-expanded')).toBe('false');
      await user.click(noteButton);
      await user.type(form.getByRole('textbox', { name: 'Note' }), 'to the airport');
      if (size === 'phone') await tap(user, form, '18');
      else await user.type(form.getByRole('textbox', { name: 'Amount' }), '18');
      await user.click(form.getByRole('button', { name: /^Save / }));
      await waitFor(() => expect(added()).toBeDefined());
      expect(added()!.transaction).toMatchObject({
        amountCents: 1_800,
        payee: 'Grab',
        note: 'to the airport',
      });
    },
  );
});

describe('a short phone', () => {
  test('Details folds the optional fields and keeps their values', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'short-phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const form = await openAdd(user);
    expect(form.getByRole('status', { name: 'Amount, RM 0.00' })).toBeTruthy();
    expect(form.getByRole('button', { name: /^From Wallet/ })).toBeTruthy();
    expect(form.getByRole('button', { name: /^For / })).toBeTruthy();
    expect(form.getByRole('group', { name: 'Keypad' })).toBeTruthy();
    expect(form.getByRole('button', { name: 'Type an amount' })).toBeTruthy();
    // Folded: the payee, recent categories, the day and Repeat
    expect(form.queryByLabelText('Payee')).toBeNull();
    expect(form.queryByRole('radiogroup', { name: 'Recent categories' })).toBeNull();
    expect(form.queryByRole('button', { name: 'Today' })).toBeNull();
    const details = form.getByRole('button', { name: /^Details/ });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(details.textContent).toContain('Payee, day, repeat');

    await user.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    await user.type(form.getByLabelText('Payee'), 'Tealive');
    expect(form.getByRole('radiogroup', { name: 'Recent categories' })).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Repeat' }));
    await user.click(form.getByRole('radio', { name: 'Monthly' }));
    // Folded again, it says what it holds
    await user.click(details);
    expect(form.queryByLabelText('Payee')).toBeNull();
    expect(details.textContent).toContain('Tealive');
    expect(details.textContent).toContain('Monthly');

    await tap(user, form, '9');
    await user.click(form.getByRole('button', { name: /^Save / }));
    await waitFor(() => expect(added()).toBeDefined());
    expect(added()!.transaction).toMatchObject({ amountCents: 900, payee: 'Tealive' });
    expect(sentChanges().some((c) => c.op === 'addRecurring')).toBe(true);
  });

  test('a day picked under Details is saved, and said on Details once folded', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'short-phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const form = await openAdd(user);
    const details = form.getByRole('button', { name: /^Details/ });
    await user.click(details);
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = form.getByLabelText('Date');
    await user.clear(day);
    await user.type(day, '2026-08-17');
    await user.click(details);
    expect(details.textContent).toContain('Aug 17');
    await tap(user, form, '5');
    await user.click(form.getByRole('button', { name: /^Save / }));
    await waitFor(() => expect(added()).toBeDefined());
    expect(added()!.transaction).toMatchObject({ amountCents: 500, date: '2026-08-17' });
  });
});

describe('what Details folds, kept steady', () => {
  test('a tablet on its side, short as it is, folds nothing', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'tablet-landscape' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const form = await openAdd(user);
    expect(form.queryByRole('button', { name: /^Details/ })).toBeNull();
    expect(form.getByLabelText('Payee')).toBeTruthy();
  });

  test('the screen growing or shrinking (bars, the keyboard) never takes the payee away while typing', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const form = await openAdd(user);
    const payee = form.getByLabelText('Payee');
    await user.type(payee, 'Te');
    resizeScreen('short-phone');
    expect(form.getByLabelText('Payee')).toBe(payee);
    expect(document.activeElement).toBe(payee);
    await user.type(payee, 'alive');
    expect(payee).toHaveProperty('value', 'Tealive');
  });

  test('a day that can’t be saved opens Details and says so on the day', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'short-phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const form = await openAdd(user);
    const details = form.getByRole('button', { name: /^Details/ });
    await user.click(details);
    await user.click(form.getByRole('button', { name: 'Today' }));
    const day = form.getByLabelText('Date');
    await user.clear(day);
    await user.type(day, '1999-12-31');
    await tap(user, form, '5');
    // Folding it away leaves it open, the day said wrong where it's typed and on the row
    await user.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    const field = form.getByLabelText('Date');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Pick a day from 2000 up to today',
    );
    expect(details.textContent).toContain('1999');
    expect(form.getByRole('button', { name: 'Pick a day from 2000 up to today' })).toBeTruthy();
  });

  test('Note puts the cursor in its field, and a note typed stays in view', async () => {
    renderApp(withWallet(), '/?accounts', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const form = await openAdd(user);
    const noteButton = form.getByRole('button', { name: 'Note' });
    await user.click(noteButton);
    const note = form.getByRole('textbox', { name: 'Note' });
    expect(document.activeElement).toBe(note);
    await user.type(note, 'birthday');
    // With something in it, Note doesn't hide it: it goes back to the field
    await user.click(noteButton);
    expect(form.getByRole('textbox', { name: 'Note' })).toHaveProperty('value', 'birthday');
    expect(document.activeElement).toBe(form.getByRole('textbox', { name: 'Note' }));
    expect(noteButton.getAttribute('aria-expanded')).toBe('true');
  });
});
