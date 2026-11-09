// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { CSV_BOM, EXPORT_COLUMNS, csvLine, exportCells, openingCells } from '@shared/export';
import type { FakeServer } from '../../testing/app';
import { closeApp, fakeServer, holdNext, renderApp, setupAppTests } from '../../testing/app';

// Importing a CSV file from Home: a bank's file mapped by column, or Mahnee's own export;
// rows that look already saved; categories from what a payee was filed under before; and
// the limit of 5,000 rows, saved through the outbox and counted once.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const MAYBANK = 'a'.repeat(16);
const WALLET = 'b'.repeat(16);
const VISA = 'e'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

type User = ReturnType<typeof userEvent.setup>;

/** Maybank with RM 1,000 and a Wallet with RM 50, the default categories saved */
function withAccounts() {
  const server = fakeServer();
  const account = { currency: 'MYR', archived: false, createdAt: Date.UTC(2026, 0, 1) };
  server.accounts.push(
    { ...account, id: MAYBANK, name: 'Maybank', kind: 'bank', openingCents: 100_000, position: 0 },
    { ...account, id: WALLET, name: 'Wallet', kind: 'cash', openingCents: 5_000, position: 1 },
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return server;
}

let seeded = 0;
/** A transaction the server already holds */
function saved(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: MAYBANK,
    toAccountId: null,
    amountCents: 800,
    categoryId: categoryId('Food'),
    payee: null,
    note: null,
    date: '2026-10-01',
    createdAt: seeded,
    ...t,
  });
}

const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

const csv = (text: string, name = 'statement.csv') => new File([text], name, { type: 'text/csv' });

/** From Home, the Import page */
async function openImport() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Import' }));
  await screen.findByRole('heading', { name: 'Import' });
  return user;
}

/** Picks the account (when given) and the file */
async function pickFile(user: User, file: File, account?: string) {
  if (account != null) {
    // Once the accounts are there to pick from
    await screen.findByRole('option', { name: account });
    await user.selectOptions(screen.getByLabelText('Account'), account);
  }
  await user.upload(screen.getByLabelText('CSV file'), file);
}

/** Says which column holds what, by the file's own column names */
async function mapColumns(user: User, columns: Record<string, string>) {
  for (const [label, column] of Object.entries(columns)) {
    await user.selectOptions(await screen.findByLabelText(label), column);
  }
}

/** The preview's row holding `text` */
function row(text: string) {
  const found = screen.getAllByRole('listitem').find((li) => li.textContent?.includes(text));
  if (found == null) throw new Error(`No row with ${text}`);
  return within(found);
}

const shownCategory = (text: string) =>
  row(text).getByLabelText<HTMLSelectElement>('Category').selectedOptions[0]?.textContent;

function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

/** What the app hands the browser to save */
function catchDownloads() {
  const files: Blob[] = [];
  const blobs = new Map<string, Blob>();
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    files.push(blobs.get(this.getAttribute('href') ?? '')!);
  });
  onTestFinished(() => {
    for (const spy of [create, revoke, click]) spy.mockRestore();
  });
  return files;
}

/** Downloads the export from Home, as the person would, and gives its text */
async function exportFromHome(files: Blob[]) {
  const user = userEvent.setup();
  const count = files.length;
  await user.click(await screen.findByRole('button', { name: 'Export' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Export' }));
  await dialog.findByText(/transactions? from/);
  await user.click(dialog.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(files).toHaveLength(count + 1));
  return files[count];
}

const BANK_FILE = [
  'Date,Description,Amount,Reference',
  '05/10/2026,Kopi Corner,-8.00,A1',
  '1 Oct 2026,Salary,"RM 5,000.00",',
  '2026-10-03,Grab,(20.00),A3',
  '31/02/2026,No such day,-1.00,',
].join('\r\n');

describe("a bank's file", () => {
  test.each(SIZES)(
    'is mapped by column, previewed and imported, and the mapping is remembered (%s)',
    async (size) => {
      const server = withAccounts();
      renderApp(server, '/', { size });
      const user = await openImport();
      await pickFile(user, csv(BANK_FILE), 'Maybank');
      await mapColumns(user, {
        Date: 'Date',
        Amount: 'Amount',
        Payee: 'Description',
        Note: 'Reference',
      });
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      // A row it can't read is shown with why, and can't be ticked
      expect(await screen.findByText(/Can't read the date/)).toBeTruthy();
      expect(row('No such day').getByRole('checkbox')).toHaveProperty('disabled', true);
      expect(row('Kopi Corner').getByRole('checkbox')).toHaveProperty('checked', true);
      await user.click(screen.getByRole('button', { name: 'Import 3 transactions' }));

      // The account's page opens with them on it, its balance moved at once
      expect(await screen.findByRole('heading', { name: 'Maybank' })).toBeTruthy();
      expect(await screen.findByText('RM 5,972.00')).toBeTruthy();
      await waitFor(() => expect(server.transactions).toHaveLength(3));
      const byPayee = (payee: string) => server.transactions.find((t) => t.payee === payee);
      expect(byPayee('Kopi Corner')).toMatchObject({
        kind: 'expense',
        accountId: MAYBANK,
        amountCents: 800,
        date: '2026-10-05',
        note: 'A1',
        categoryId: categoryId('Other'),
      });
      expect(byPayee('Salary')).toMatchObject({
        kind: 'income',
        amountCents: 500_000,
        date: '2026-10-01',
        note: null,
        categoryId: categoryId('Other income'),
      });
      expect(byPayee('Grab')).toMatchObject({ kind: 'expense', amountCents: 2_000 });

      // The next file for Maybank is mapped as before; another account's isn't
      await user.click(screen.getByRole('button', { name: 'Home' }));
      await openImport();
      await pickFile(user, csv(BANK_FILE.replace('Kopi Corner', 'Kopi Place')), 'Maybank');
      expect(await screen.findByLabelText('Date')).toHaveProperty('value', 'Date');
      expect(screen.getByLabelText('Amount')).toHaveProperty('value', 'Amount');
      expect(screen.getByLabelText('Payee')).toHaveProperty('value', 'Description');
      expect(screen.getByLabelText('Note')).toHaveProperty('value', 'Reference');
      await user.selectOptions(screen.getByLabelText('Account'), 'Wallet');
      expect(screen.getByLabelText('Date')).toHaveProperty('value', '');
    },
  );

  test.each(SIZES)('reads money in and money out from two columns (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/', { size });
    const user = await openImport();
    await pickFile(
      user,
      csv(
        'Txn date,Details,Debit,Credit\n' +
          '4 Oct 2026,Tesco,"1,234.50",\n' +
          '6 Oct 2026,Refund,,RM 12.00\n',
      ),
      'Wallet',
    );
    await user.click(await screen.findByRole('radio', { name: 'Money in and out' }));
    await mapColumns(user, {
      'Date': 'Txn date',
      'Money in': 'Credit',
      'Money out': 'Debit',
      'Payee': 'Details',
    });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));

    await waitFor(() => expect(server.transactions).toHaveLength(2));
    expect(server.transactions.find((t) => t.payee === 'Tesco')).toMatchObject({
      kind: 'expense',
      accountId: WALLET,
      amountCents: 123_450,
      date: '2026-10-04',
    });
    expect(server.transactions.find((t) => t.payee === 'Refund')).toMatchObject({
      kind: 'income',
      amountCents: 1_200,
      date: '2026-10-06',
    });
  });
});

describe('a payee or note too long to keep', () => {
  test.each(SIZES)('is shortened to fit, and the row says so (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/', { size });
    const user = await openImport();
    const payee = `Long${'x'.repeat(90)}`;
    await pickFile(
      user,
      csv(
        'Date,Description,Amount,Reference\n' +
          `05/10/2026,${payee},-8.00,${'y'.repeat(510)}\n` +
          '06/10/2026,Short,-2.00,Fine\n',
      ),
      'Maybank',
    );
    await mapColumns(user, {
      Date: 'Date',
      Amount: 'Amount',
      Payee: 'Description',
      Note: 'Reference',
    });
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText(/Payee shortened to 80 characters/)).toBeTruthy();
    expect(row('Longxxx').getByText(/Payee shortened to 80 characters/)).toBeTruthy();
    expect(row('Longxxx').getByText(/Note shortened to 500 characters/)).toBeTruthy();
    expect(row('Short').queryByText(/shortened/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }));

    await waitFor(() => expect(server.transactions).toHaveLength(2));
    const long = server.transactions.find((t) => t.payee?.startsWith('Long'));
    expect(long).toMatchObject({ payee: payee.slice(0, 80), note: 'y'.repeat(500) });
    expect(server.transactions.find((t) => t.payee === 'Short')).toMatchObject({ note: 'Fine' });
  });
});

describe('rows that look already saved', () => {
  test.each(SIZES)(
    'are marked and left unticked, can be ticked anyway, and a second import adds nothing (%s)',
    async (size) => {
      const server = withAccounts();
      // Same account, day, amount and payee (in other letters and spacing)
      saved(server, { payee: ' kopi CORNER ', date: '2026-10-05', amountCents: 800 });
      // The same but on the Wallet: not the same account
      saved(server, { payee: 'Grab', date: '2026-10-03', amountCents: 2_000, accountId: WALLET });
      const file = csv(
        'Date,Description,Amount\n' + '05/10/2026,Kopi Corner,-8.00\n' + '03/10/2026,Grab,-20.00\n',
      );
      renderApp(server, '/', { size });
      const user = await openImport();
      await pickFile(user, file, 'Maybank');
      await mapColumns(user, { Date: 'Date', Amount: 'Amount', Payee: 'Description' });
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      expect(await screen.findByText('Looks already saved')).toBeTruthy();
      expect(row('Kopi Corner').getByText('Looks already saved')).toBeTruthy();
      expect(row('Kopi Corner').getByRole('checkbox')).toHaveProperty('checked', false);
      expect(row('Grab').queryByText('Looks already saved')).toBeNull();
      expect(row('Grab').getByRole('checkbox')).toHaveProperty('checked', true);
      // Ticked, it would be imported anyway; left as it is, only Grab is
      await user.click(row('Kopi Corner').getByRole('checkbox'));
      expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeTruthy();
      await user.click(row('Kopi Corner').getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Import 1 transaction' }));
      await waitFor(() => expect(server.transactions).toHaveLength(3));

      // The same file again: everything in it is saved already, so nothing is added
      await user.click(await screen.findByRole('button', { name: 'Home' }));
      await openImport();
      await pickFile(user, file, 'Maybank');
      await user.click(await screen.findByRole('button', { name: 'Preview' }));
      await waitFor(() => expect(screen.getAllByText('Looks already saved')).toHaveLength(2));
      expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(server.transactions).toHaveLength(3);
    },
  );

  test('one ticked anyway is imported as well', async () => {
    const server = withAccounts();
    saved(server, { payee: 'Kopi Corner', date: '2026-10-05', amountCents: 800 });
    renderApp(server);
    const user = await openImport();
    await pickFile(user, csv('Date,Description,Amount\n05/10/2026,Kopi Corner,-8.00\n'), 'Maybank');
    await mapColumns(user, { Date: 'Date', Amount: 'Amount', Payee: 'Description' });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(row('Looks already saved').getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Import 1 transaction' }));
    await waitFor(() => expect(server.transactions).toHaveLength(2));
    expect(server.transactions.filter((t) => t.payee === 'Kopi Corner')).toHaveLength(2);
  });
});

describe('what the page says', () => {
  test.each(SIZES)('that dates are read day first (%s)', async (size) => {
    renderApp(withAccounts(), '/', { size });
    const user = await openImport();
    await pickFile(user, csv(BANK_FILE), 'Maybank');
    expect(
      await screen.findByText(/Dates are read as day, month, year \(31\/01\/2026\)/),
    ).toBeTruthy();
  });

  test.each(SIZES)(
    "that categories used before couldn't be looked up, when the server fails (%s)",
    async (size) => {
      const server = withAccounts();
      saved(server, { payee: 'Grab', categoryId: categoryId('Transport') });
      server.failNext.payeeCategories = 500;
      renderApp(server, '/', { size });
      const user = await openImport();
      await pickFile(user, csv('Date,Description,Amount\n05/10/2026,Grab,-20.00\n'), 'Maybank');
      await mapColumns(user, { Date: 'Date', Amount: 'Amount', Payee: 'Description' });
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      expect(
        await screen.findByText(/Couldn't look up categories you've used before/),
      ).toBeTruthy();
      expect(shownCategory('Grab')).toBe('Other');

      // Asked again, it's known, and nothing more is said
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await waitFor(() => expect(shownCategory('Grab')).toBe('Transport'));
      expect(screen.queryByText(/Couldn't look up categories/)).toBeNull();
    },
  );
});

describe('categories', () => {
  test.each(SIZES)(
    "use the payee's last category, else Other or Other income, changeable per row (%s)",
    async (size) => {
      const server = withAccounts();
      const coffee = 'c'.repeat(16);
      server.categories.push({
        id: coffee,
        name: 'Coffee',
        kind: 'expense',
        parentId: categoryId('Food'),
        position: 0,
        archived: false,
      });
      // Filed before, on another account too
      saved(server, { payee: 'Grab', categoryId: categoryId('Transport'), accountId: WALLET });
      saved(server, { payee: 'Kopi Corner', categoryId: coffee, date: '2026-09-01' });
      renderApp(server, '/', { size });
      const user = await openImport();
      await pickFile(
        user,
        csv(
          'Date,Description,Amount\n' +
            '05/10/2026,GRAB,-20.00\n' +
            '05/10/2026, kopi corner ,-8.00\n' +
            '06/10/2026,New Shop,-5.00\n' +
            '07/10/2026,Refund,12.00\n',
        ),
        'Maybank',
      );
      await mapColumns(user, { Date: 'Date', Amount: 'Amount', Payee: 'Description' });
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      await waitFor(() => expect(shownCategory('GRAB')).toBe('Transport'));
      expect(shownCategory('kopi corner')).toBe('Food › Coffee');
      expect(shownCategory('New Shop')).toBe('Other');
      expect(shownCategory('Refund')).toBe('Other income');
      await user.selectOptions(row('New Shop').getByLabelText('Category'), 'Shopping');
      await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }));

      await waitFor(() => expect(server.transactions).toHaveLength(6));
      const filedAs = (payee: string) =>
        server.transactions.find((t) => t.payee === payee && t.date >= '2026-10-05')?.categoryId;
      expect(filedAs('GRAB')).toBe(categoryId('Transport'));
      expect(filedAs('kopi corner')).toBe(coffee);
      expect(filedAs('New Shop')).toBe(categoryId('Shopping'));
      expect(filedAs('Refund')).toBe(categoryId('Other income'));
    },
  );
});

describe('the limit', () => {
  /** A bank file of `n` rows of RM 1 spent, each at a shop of its own */
  const rows = (n: number) =>
    csv(
      [
        'Date,Description,Amount',
        ...Array.from(
          { length: n },
          (_, i) =>
            `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')},Shop ${i},-1.00`,
        ),
      ].join('\n'),
    );

  test.each(SIZES)('refuses more than 5,000 rows before the preview (%s)', async (size) => {
    renderApp(withAccounts(), '/', { size });
    const user = await openImport();
    await pickFile(user, rows(5_001), 'Maybank');
    expect(await screen.findByText(/5,001 rows/)).toBeTruthy();
    expect(screen.getByText(/up to 5,000/)).toBeTruthy();
    expect(screen.queryByLabelText('Date')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Import \d/ })).toBeNull();
  });

  test('imports 5,000 rows on a phone, through the outbox, each counted once', async () => {
    const server = withAccounts();
    renderApp(server, '/', { size: 'phone' });
    const user = await openImport();
    await pickFile(user, rows(5_000), 'Maybank');
    await mapColumns(user, { Date: 'Date', Amount: 'Amount', Payee: 'Description' });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const importAll = await screen.findByRole('button', { name: 'Import 5,000 transactions' });
    // One batch is saved but its answer never arrives: sent again, it counts once
    server.loseNext.changes = true;
    await user.click(importAll);

    // RM 1,000 less 5,000 x RM 1, shown at once and once saved
    expect((await screen.findAllByText('−RM 4,000.00')).length).toBeGreaterThan(0);
    await waitFor(() => expect(server.transactions).toHaveLength(5_000), { timeout: 45_000 });
    expect(new Set(server.transactions.map((t) => t.payee)).size).toBe(5_000);
    // Nothing is left waiting on the device: the export says so, counted by the server
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Export' }));
    expect(
      await dialog.findByText(/^5,000 transactions from /, undefined, { timeout: 10_000 }),
    ).toBeTruthy();
    await waitFor(() => expect(dialog.queryByText(/still being saved/)).toBeNull(), {
      timeout: 10_000,
    });
    expect(server.transactions).toHaveLength(5_000);
    expect(screen.getAllByText('−RM 4,000.00').length).toBeGreaterThan(0);
  }, 90_000);

  test('imports offline, knows what it has imported, and saves it once back', async () => {
    const server = withAccounts();
    renderApp(server, '/', { size: 'phone' });
    const user = await openImport();
    const file = csv(
      'Date,Description,Amount\n05/10/2026,Kopi Corner,-8.00\n06/10/2026,Grab,-20.00\n',
    );
    // Offline once the accounts have arrived: with nothing kept yet, offline has none
    await screen.findByRole('option', { name: 'Maybank' });
    const backOnline = goOffline(server);
    await pickFile(user, file, 'Maybank');
    await mapColumns(user, { Date: 'Date', Amount: 'Amount', Payee: 'Description' });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));
    expect(await screen.findByText('RM 972.00')).toBeTruthy();

    // Imported again before it's saved: still known, so nothing is added twice
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await openImport();
    await pickFile(user, file, 'Maybank');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getAllByText('Looks already saved')).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toHaveProperty(
      'disabled',
      true,
    );

    backOnline();
    await waitFor(() => expect(server.transactions).toHaveLength(2));
    expect(server.transactions.map((t) => t.amountCents).sort()).toEqual([2_000, 800]);
  });
});

describe("Mahnee's own export", () => {
  /** Accounts of each kind, a subcategory, an archived account and category, and odd text */
  function withHistory() {
    const server = withAccounts();
    const account = { currency: 'MYR', archived: false, createdAt: Date.UTC(2026, 0, 2) };
    server.accounts.push(
      { ...account, id: VISA, name: 'Visa', kind: 'card', openingCents: -32_000, position: 2 },
      {
        ...account,
        id: 'f'.repeat(16),
        name: 'Savings',
        kind: 'bank',
        openingCents: 150_000,
        position: 3,
      },
      {
        ...account,
        id: '9'.repeat(16),
        name: 'Old card',
        kind: 'card',
        openingCents: 0,
        position: 4,
        archived: true,
      },
    );
    const [coffee, gifts] = ['c'.repeat(16), '8'.repeat(16)];
    server.categories.push(
      {
        id: coffee,
        name: 'Coffee',
        kind: 'expense',
        parentId: categoryId('Food'),
        position: 0,
        archived: false,
      },
      { id: gifts, name: 'Gifts', kind: 'expense', parentId: null, position: 8, archived: true },
    );
    saved(server, {
      categoryId: coffee,
      payee: 'Kopi, "Corner"\nSS2',
      note: '-RM5 off',
      amountCents: 123_450,
      date: '2026-10-04',
    });
    saved(server, {
      kind: 'income',
      categoryId: categoryId('Salary'),
      payee: '=HYPERLINK("x")',
      note: 'October',
      amountCents: 500_000,
      date: '2026-10-02',
    });
    saved(server, {
      kind: 'transfer',
      toAccountId: VISA,
      categoryId: null,
      amountCents: 10_000,
      date: '2026-10-03',
    });
    // Two on one day: kept in their order
    saved(server, { accountId: WALLET, payee: 'First', date: '2026-10-03' });
    saved(server, { accountId: WALLET, payee: 'Second', date: '2026-10-03' });
    saved(server, { accountId: '9'.repeat(16), categoryId: gifts, date: '2025-12-24' });
    return server;
  }

  /** The file without what a restore can't keep: ids, and the days accounts were added */
  const comparable = (text: string) =>
    text
      .replace(/,[0-9a-f]{16}\r\n/g, '\r\n')
      .replace(/^\d{4}-\d{2}-\d{2},Opening balance,/gm, 'added,Opening balance,');

  test.each(SIZES)(
    'imported into a fresh account, restores everything: exported again, it matches (%s)',
    async (size) => {
      const before = withHistory();
      const files = catchDownloads();
      renderApp(before, '/', { size });
      const exported = await exportFromHome(files);
      const original = new TextDecoder().decode(await exported.arrayBuffer());

      // Someone starting afresh, with nothing yet
      await closeApp();
      const after = fakeServer();
      renderApp(after, '/', { size });
      const user = await openImport();
      await pickFile(user, new File([original], 'mahnee-2026-11-06.csv', { type: 'text/csv' }));
      expect(await screen.findByText(/Mahnee export/)).toBeTruthy();
      // Its accounts are added; the file doesn't say their kinds, so they're asked
      for (const [name, kind] of [
        ['Maybank', 'bank'],
        ['Wallet', 'cash'],
        ['Visa', 'card'],
        ['Savings', 'bank'],
        ['Old card', 'card'],
      ]) {
        await user.selectOptions(screen.getByLabelText(`Kind of ${name}`), kind);
      }
      await user.click(screen.getByRole('button', { name: 'Import 6 transactions' }));

      await waitFor(() => expect(after.transactions).toHaveLength(6));
      expect(after.accounts.map((a) => [a.name, a.kind, a.openingCents])).toEqual(
        before.accounts.map((a) => [a.name, a.kind, a.openingCents]),
      );
      const restored = await exportFromHome(files);
      expect(comparable(new TextDecoder().decode(await restored.arrayBuffer()))).toBe(
        comparable(original),
      );

      // Imported again, it adds nothing
      await openImport();
      await pickFile(user, new File([original], 'mahnee-2026-11-06.csv', { type: 'text/csv' }));
      expect(await screen.findByRole('button', { name: 'Import 0 transactions' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(screen.getAllByText('Looks already saved')).toHaveLength(6);
    },
    30_000,
  );
  /** An export naming Maybank (opening `maybankCents`) and Wallet (RM 50, as it is) */
  const exportOf = (maybankCents: number) =>
    csv(
      CSV_BOM +
        csvLine(EXPORT_COLUMNS) +
        csvLine(
          openingCells({
            id: MAYBANK,
            name: 'Maybank',
            currency: 'MYR',
            openingCents: maybankCents,
            createdAt: 0,
          }),
        ) +
        csvLine(
          openingCells({
            id: WALLET,
            name: 'Wallet',
            currency: 'MYR',
            openingCents: 5_000,
            createdAt: 0,
          }),
        ) +
        csvLine(
          exportCells(
            {
              id: '1'.repeat(16),
              kind: 'expense',
              accountId: MAYBANK,
              toAccountId: null,
              amountCents: 800,
              categoryId: categoryId('Food'),
              payee: 'Kopi',
              note: null,
              date: '2026-10-05',
            },
            {
              accounts: new Map([[MAYBANK, { name: 'Maybank', currency: 'MYR' }]]),
              categories: new Map([[categoryId('Food'), { name: 'Food', parentId: null }]]),
            },
          ),
        ),
      'mahnee-2026-11-06.csv',
    );
  const openingLines = () =>
    screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('Opening balance'));

  test.each(SIZES)(
    "never changes an existing account's opening balance unless that line is ticked (%s)",
    async (size) => {
      const server = withAccounts();
      renderApp(server, '/', { size });
      const user = await openImport();
      await pickFile(user, exportOf(150_000));
      expect(await screen.findByText(/Mahnee export/)).toBeTruthy();

      // Maybank's differs: listed with both amounts, unticked. Wallet's is the same: not listed.
      await waitFor(() => expect(openingLines()).toHaveLength(1));
      const line = within(openingLines()[0]);
      expect(openingLines()[0].textContent).toMatch(/Maybank/);
      expect(openingLines()[0].textContent).toMatch(/RM 1,000\.00/);
      expect(openingLines()[0].textContent).toMatch(/RM 1,500\.00/);
      expect(line.getByRole('checkbox')).toHaveProperty('checked', false);
      await user.click(screen.getByRole('button', { name: 'Import 1 transaction' }));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.accounts.find((a) => a.id === MAYBANK)?.openingCents).toBe(100_000);
      expect(await screen.findByText('RM 992.00')).toBeTruthy();

      // Ticked, it's applied, once
      await openImport();
      await pickFile(user, exportOf(150_000));
      await waitFor(() => expect(openingLines()).toHaveLength(1));
      await user.click(within(openingLines()[0]).getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Import 0 transactions' }));
      await waitFor(() =>
        expect(server.accounts.find((a) => a.id === MAYBANK)?.openingCents).toBe(150_000),
      );
      expect(server.transactions).toHaveLength(1);
      expect(await screen.findByText('RM 1,492.00')).toBeTruthy();

      // Now the same: nothing to say about it
      await openImport();
      await pickFile(user, exportOf(150_000));
      await screen.findByText('Looks already saved');
      expect(openingLines()).toHaveLength(0);
    },
    30_000,
  );

  test.each(SIZES)(
    'picked before the accounts have loaded, is looked over once they have (%s)',
    async (size) => {
      const server = withAccounts();
      // The accounts and categories are asked for twice as the app opens: both held
      const answers = [1, 2].map(() => holdNext(server, 'GET', '/api/accounts'));
      renderApp(server, '/', { size });
      const user = await openImport();
      await pickFile(user, exportOf(150_000));
      expect(await screen.findByText(/Mahnee export/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Import \d/ })).toBeNull();

      answers.forEach((a) => a.release());
      await waitFor(() => expect(openingLines()).toHaveLength(1));
      expect(openingLines()[0].textContent).toMatch(/Maybank/);
      await user.click(await screen.findByRole('button', { name: 'Import 1 transaction' }));
      await waitFor(() => expect(server.transactions).toHaveLength(1));
      expect(server.transactions[0].payee).toBe('Kopi');
    },
  );
});

describe("repeating bills in Mahnee's export", () => {
  /** The app's clock reads Friday 6 November 2026, mid-morning, and still ticks */
  function onTheSixth() {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }

  const repeating = (id: string, more: Partial<Recurring>): Recurring => ({
    id: id.repeat(16),
    kind: 'expense',
    accountId: MAYBANK,
    toAccountId: null,
    amountCents: 120_000,
    categoryId: categoryId('Bills'),
    payee: 'Rent',
    schedule: 'monthly',
    day: 1,
    startDate: '2026-10-01',
    nextDue: '2026-12-01',
    archived: false,
    ...more,
  });

  /**
   * Maybank and Wallet with two transactions; Rent due next on 1 Dec, Salary overdue since
   * 25 Oct, Gym stopped
   */
  function withRepeating() {
    const server = withAccounts();
    saved(server, { payee: 'Kopi', date: '2026-10-01' });
    saved(server, { payee: 'Mamak', date: '2026-10-02' });
    server.recurring = [
      repeating('1', {}),
      repeating('2', {
        payee: 'Gym',
        amountCents: 9_900,
        schedule: 'weekly',
        day: 1,
        nextDue: '2026-11-09',
        archived: true,
      }),
      repeating('3', {
        kind: 'income',
        accountId: WALLET,
        amountCents: 500_000,
        categoryId: categoryId('Salary'),
        payee: 'Salary',
        day: 25,
        startDate: '2026-09-25',
        nextDue: '2026-10-25',
      }),
    ];
    return server;
  }

  test.each(SIZES)(
    'restores the running ones from a fresh start, moving a passed next due on, and adds them once (%s)',
    async (size) => {
      onTheSixth();
      const before = withRepeating();
      const files = catchDownloads();
      renderApp(before, '/', { size });
      const original = new TextDecoder().decode(await (await exportFromHome(files)).arrayBuffer());
      // Each running one has its line, in the order they were set up; the stopped one has none
      const rent = `2026-12-01,Repeating spent,Maybank,,1200.00,MYR,Bills,,Rent,"Monthly, day 1",${'1'.repeat(16)}\r\n`;
      const salary = `2026-10-25,Repeating received,Wallet,,5000.00,MYR,Salary,,Salary,"Monthly, day 25",${'3'.repeat(16)}\r\n`;
      expect(original).toContain(rent + salary);
      expect(original).not.toMatch(/Gym/);

      // Someone starting afresh, with nothing yet
      await closeApp();
      const after = fakeServer();
      renderApp(after, '/', { size });
      const user = await openImport();
      await pickFile(user, new File([original], 'mahnee-2026-11-06.csv', { type: 'text/csv' }));
      await screen.findByLabelText('Kind of Wallet');
      await user.selectOptions(screen.getByLabelText('Kind of Wallet'), 'cash');
      await user.click(
        await screen.findByRole('button', { name: 'Import 2 transactions and 2 repeating items' }),
      );
      expect(await screen.findByText('Imported 2 transactions and 2 repeating items')).toBeTruthy();

      await waitFor(() => expect(after.recurring).toHaveLength(2));
      const id = (name: string) => after.accounts.find((a) => a.name === name)!.id;
      expect(after.recurring).toEqual([
        expect.objectContaining({
          kind: 'expense',
          accountId: id('Maybank'),
          toAccountId: null,
          amountCents: 120_000,
          categoryId: categoryId('Bills'),
          payee: 'Rent',
          schedule: 'monthly',
          day: 1,
          // After today: as the file has it
          nextDue: '2026-12-01',
          archived: false,
        }),
        expect.objectContaining({
          kind: 'income',
          accountId: id('Wallet'),
          amountCents: 500_000,
          categoryId: categoryId('Salary'),
          payee: 'Salary',
          schedule: 'monthly',
          day: 25,
          // 25 October has passed: the next 25th after today
          nextDue: '2026-11-25',
          archived: false,
        }),
      ]);
      // Nothing recorded for them: the file's two transactions are all there is
      expect(after.transactions.map((t) => t.payee).sort()).toEqual(['Kopi', 'Mamak']);

      // Imported again, it adds nothing
      await openImport();
      await pickFile(user, new File([original], 'mahnee-2026-11-06.csv', { type: 'text/csv' }));
      // Both transactions and both repeating ones
      await waitFor(() => expect(screen.getAllByText('Looks already saved')).toHaveLength(4));
      expect(screen.getByRole('button', { name: /^Import / })).toHaveProperty('disabled', true);
      expect(
        screen.getByRole('button', { name: 'Import 0 transactions and 0 repeating items' }),
      ).toBeTruthy();
      expect(after.recurring).toHaveLength(2);

      // The same details but for the amount: it's added
      await pickFile(
        user,
        new File([original.replace('1200.00', '1300.00')], 'mahnee-2026-11-06.csv', {
          type: 'text/csv',
        }),
      );
      await waitFor(() => expect(screen.getAllByText('Looks already saved')).toHaveLength(3));
      await user.click(screen.getByRole('button', { name: /^Import / }));
      await waitFor(() => expect(after.recurring).toHaveLength(3));
      expect(after.transactions).toHaveLength(2);
      expect(after.recurring[2]).toMatchObject({
        payee: 'Rent',
        amountCents: 130_000,
        nextDue: '2026-12-01',
      });
    },
    30_000,
  );

  test.each(SIZES)(
    'counts only running ones as already there: a stopped one of the same details is added again (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts();
      server.recurring = [repeating('4', { archived: true })];
      renderApp(server, '/', { size });
      const user = await openImport();
      const file =
        CSV_BOM +
        csvLine(EXPORT_COLUMNS) +
        `2026-12-01,Repeating spent,Maybank,,1200.00,MYR,Bills,,Rent,"Monthly, day 1",${'4'.repeat(16)}\r\n`;
      await pickFile(user, csv(file, 'mahnee-2026-11-06.csv'));
      await screen.findByText(/Mahnee export/);
      await user.click(await screen.findByRole('button', { name: /^Import / }));
      await waitFor(() => expect(server.recurring).toHaveLength(2));
      expect(server.recurring[1]).toMatchObject({
        accountId: MAYBANK,
        payee: 'Rent',
        nextDue: '2026-12-01',
        archived: false,
      });
    },
  );
});

describe("repeating lines in Mahnee's export: dates, what's already there, and what they name", () => {
  /** The app's clock reads `at` (local time), and still ticks */
  function clockAt(at: Date) {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(at);
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }
  /** Friday 6 November 2026, mid-morning */
  const onTheSixth = () => clockAt(new Date(2026, 10, 6, 10, 0, 0));

  let made = 0;
  const repeating = (more: Partial<Recurring>): Recurring => ({
    id: (++made).toString(16).padStart(16, '7'),
    kind: 'expense',
    accountId: MAYBANK,
    toAccountId: null,
    amountCents: 120_000,
    categoryId: categoryId('Bills'),
    payee: 'Rent',
    schedule: 'monthly',
    day: 1,
    startDate: '2026-10-01',
    nextDue: '2026-12-01',
    archived: false,
    ...more,
  });

  /** A Repeating line as the export writes it; Rent, RM 1,200 from Maybank on the 1st by default */
  const line = ({
    date = '2026-12-01',
    kind = 'spent',
    account = 'Maybank',
    to = '',
    amount = '1200.00',
    category = 'Bills',
    parent = '',
    payee = 'Rent',
    schedule = '"Monthly, day 1"',
  } = {}) =>
    `${date},Repeating ${kind},${account},${to},${amount},MYR,${category},${parent},${payee},${schedule},${'1'.repeat(16)}`;
  const fileOf = (...lines: string[]) =>
    csv(
      CSV_BOM + csvLine(EXPORT_COLUMNS) + lines.map((l) => `${l}\r\n`).join(''),
      'mahnee-2026-11-06.csv',
    );

  /** Opens Import on Home and picks `file`, an export */
  async function importing(server: FakeServer, file: File, size: (typeof SIZES)[number]) {
    renderApp(server, '/', { size });
    const user = await openImport();
    await pickFile(user, file);
    await screen.findByText(/Mahnee export/);
    return user;
  }

  test.each(SIZES)(
    "keeps the file's next due when it's today or later, even a later occurrence; moves one that passed (%s)",
    async (size) => {
      onTheSixth();
      const before = withAccounts();
      saved(before, { payee: 'Kopi', date: '2026-10-01' });
      saved(before, { payee: 'Mamak', date: '2026-10-02' });
      before.recurring = [
        // Not the next 1st (1 December) but the one after
        repeating({ payee: 'Insurance', nextDue: '2027-01-01' }),
        // Mondays: not the next (9 November) but the 23rd
        repeating({ payee: 'Gym', schedule: 'weekly', day: 1, nextDue: '2026-11-23' }),
        // Fridays: due today
        repeating({ payee: 'Laundry', schedule: 'weekly', day: 5, nextDue: '2026-11-06' }),
        // Thursdays: due yesterday, so the next Thursday
        repeating({ payee: 'Badminton', schedule: 'weekly', day: 4, nextDue: '2026-11-05' }),
      ];
      const files = catchDownloads();
      renderApp(before, '/', { size });
      const original = new TextDecoder().decode(await (await exportFromHome(files)).arrayBuffer());
      expect(original).toContain(
        '2026-11-23,Repeating spent,Maybank,,1200.00,MYR,Bills,,Gym,"Weekly, day 1"',
      );

      await closeApp();
      const after = fakeServer();
      renderApp(after, '/', { size });
      const user = await openImport();
      await pickFile(user, new File([original], 'mahnee-2026-11-06.csv', { type: 'text/csv' }));
      await screen.findByLabelText('Kind of Wallet');
      await user.click(await screen.findByRole('button', { name: /^Import / }));
      await waitFor(() => expect(after.recurring).toHaveLength(4));
      expect(after.recurring.map((r) => [r.payee, r.schedule, r.day, r.nextDue])).toEqual([
        ['Insurance', 'monthly', 1, '2027-01-01'],
        ['Gym', 'weekly', 1, '2026-11-23'],
        ['Laundry', 'weekly', 5, '2026-11-06'],
        ['Badminton', 'weekly', 4, '2026-11-12'],
      ]);
      // Set up on the day it was imported
      expect(after.recurring.map((r) => r.startDate)).toEqual(Array(4).fill('2026-11-06'));
    },
    30_000,
  );

  test.each(SIZES)(
    "moves a passed next due on from the person's own day, not UTC's (%s)",
    async (size) => {
      const zone = process.env.TZ;
      process.env.TZ = 'Asia/Kuala_Lumpur';
      onTestFinished(() => {
        process.env.TZ = zone;
      });
      // Saturday 7 November, 1 a.m. in Kuala Lumpur; still Friday the 6th in UTC
      clockAt(new Date(2026, 10, 7, 1, 0, 0));
      const server = withAccounts();
      // Fridays, due the 6th: passed there, so the next Friday (UTC's day would keep the 6th)
      const user = await importing(
        server,
        fileOf(line({ date: '2026-11-06', payee: 'Laundry', schedule: '"Weekly, day 5"' })),
        size,
      );
      await user.click(await screen.findByRole('button', { name: /^Import / }));
      await waitFor(() => expect(server.recurring).toHaveLength(1));
      expect(server.recurring[0]).toMatchObject({ nextDue: '2026-11-13', startDate: '2026-11-07' });
    },
  );

  test.each(SIZES)(
    'counts as already there only the same account, amount, kind, schedule, day and payee (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts();
      server.accounts.push({
        id: VISA,
        name: 'Visa',
        kind: 'card',
        currency: 'MYR',
        openingCents: 0,
        position: 2,
        archived: false,
      });
      // Three Rents alike, each answering for one line, and a transfer to Wallet on the 28th
      server.recurring = [
        repeating({}),
        repeating({}),
        repeating({}),
        repeating({
          kind: 'transfer',
          toAccountId: WALLET,
          categoryId: null,
          payee: null,
          amountCents: 30_000,
          day: 28,
          nextDue: '2026-11-28',
        }),
      ];
      const user = await importing(
        server,
        fileOf(
          // Each differs in one detail the owner listed: added
          line({ account: 'Wallet' }),
          line({ kind: 'received', category: 'Salary' }),
          line({ date: '2026-12-07', schedule: '"Weekly, day 1"' }),
          line({ date: '2026-12-02', schedule: '"Monthly, day 2"' }),
          line({ payee: 'Rental' }),
          // Already there: the payee trimmed and ignoring case, another category, another next due
          line({ payee: ' RENT ' }),
          line({ category: 'Food' }),
          line({ date: '2027-01-01' }),
          // A transfer to another account, the rest the same: the to-account isn't compared
          line({
            date: '2026-11-28',
            kind: 'transfer',
            to: 'Visa',
            amount: '300.00',
            category: '',
            payee: '',
            schedule: '"Monthly, day 28"',
          }),
        ),
        size,
      );
      await waitFor(() => expect(screen.getAllByText('Looks already saved')).toHaveLength(4));
      for (const [n, saved] of [
        [2, false],
        [3, false],
        [4, false],
        [5, false],
        [6, false],
        [7, true],
        [8, true],
        [9, true],
        [10, true],
      ] as const) {
        expect(screen.getByLabelText<HTMLInputElement>(`Import row ${n}`).checked).toBe(!saved);
      }
      await user.click(screen.getByRole('button', { name: /^Import / }));
      await waitFor(() => expect(server.recurring).toHaveLength(9));
      expect(
        server.recurring.slice(4).map((r) => [r.accountId, r.kind, r.schedule, r.day, r.payee]),
      ).toEqual([
        [WALLET, 'expense', 'monthly', 1, 'Rent'],
        [MAYBANK, 'income', 'monthly', 1, 'Rent'],
        [MAYBANK, 'expense', 'weekly', 1, 'Rent'],
        [MAYBANK, 'expense', 'monthly', 2, 'Rent'],
        [MAYBANK, 'expense', 'monthly', 1, 'Rental'],
      ]);
    },
    30_000,
  );

  test.each([
    ['none saved: both added', [], 2],
    ['one running: one added', [{}], 1],
    ['one stopped only: both added', [{ archived: true }], 2],
    ['one running and one stopped: one added', [{}, { archived: true }], 1],
  ] as const)('two alike in a file, %s', async (_what, saved, added) => {
    onTheSixth();
    const server = withAccounts();
    server.recurring = saved.map((more) => repeating(more));
    const user = await importing(server, fileOf(line(), line()), 'desktop');
    await user.click(await screen.findByRole('button', { name: /^Import / }));
    await waitFor(() => expect(server.recurring).toHaveLength(saved.length + added));
    await pause(50);
    expect(server.recurring).toHaveLength(saved.length + added);
  });

  test.each(SIZES)(
    'restores what each names: a transfer, new categories and subcategories, an archived one as Other (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts();
      const gifts = '8'.repeat(16);
      server.categories.push({
        id: gifts,
        name: 'Gifts',
        kind: 'expense',
        parentId: null,
        position: 8,
        archived: true,
      });
      const user = await importing(
        server,
        fileOf(
          line({
            date: '2026-11-28',
            kind: 'transfer',
            to: 'Wallet',
            amount: '300.00',
            category: '',
            payee: '',
            schedule: '"Monthly, day 28"',
          }),
          line({
            date: '2026-12-03',
            amount: '50.00',
            category: 'Pets',
            payee: 'Vet',
            schedule: '"Monthly, day 3"',
          }),
          line({
            date: '2026-12-04',
            amount: '20.00',
            category: 'Netflix',
            parent: 'Bills',
            payee: 'Netflix',
            schedule: '"Monthly, day 4"',
          }),
          line({
            date: '2026-12-05',
            amount: '30.00',
            category: 'Gifts',
            payee: 'Mum',
            schedule: '"Monthly, day 5"',
          }),
          // Neither the person's account nor one the file adds
          line({ account: 'CIMB', payee: 'Loan' }),
        ),
        size,
      );
      expect(await screen.findByText('CIMB is not an account here or in this file')).toBeTruthy();
      await user.click(await screen.findByRole('button', { name: /^Import / }));
      await waitFor(() => expect(server.recurring).toHaveLength(4));
      const named = (name: string, parentId: string | null) =>
        server.categories.find((c) => c.name === name && c.parentId === parentId)?.id;
      expect(named('Pets', null)).toBeTruthy();
      expect(named('Netflix', categoryId('Bills'))).toBeTruthy();
      expect(
        server.recurring.map((r) => [r.kind, r.accountId, r.toAccountId, r.categoryId]),
      ).toEqual([
        ['transfer', MAYBANK, WALLET, null],
        ['expense', MAYBANK, null, named('Pets', null)],
        ['expense', MAYBANK, null, named('Netflix', categoryId('Bills'))],
        ['expense', MAYBANK, null, categoryId('Other')],
      ]);
      expect(server.recurring.some((r) => r.payee === 'Loan')).toBe(false);
    },
    30_000,
  );

  test.each(SIZES)(
    'adds up to the limit of 200, stopped ones counted, and says so on the line past it (%s)',
    async (size) => {
      onTheSixth();
      const server = withAccounts();
      server.recurring = Array.from({ length: 199 }, (_, i) =>
        repeating({ payee: `Bill ${i}`, archived: i < 10 }),
      );
      const user = await importing(
        server,
        fileOf(line({ payee: 'Water' }), line({ payee: 'Power' })),
        size,
      );
      expect(
        await screen.findByText('You can have up to 200 repeating items, stopped ones included'),
      ).toBeTruthy();
      await user.click(await screen.findByRole('button', { name: /^Import / }));
      await waitFor(() => expect(server.recurring).toHaveLength(200));
      expect(server.recurring[199].payee).toBe('Water');
      await pause(50);
      expect(server.recurring).toHaveLength(200);
    },
    30_000,
  );

  test.each(SIZES)(
    "says on its row why a line can't be read, and imports the rest (%s)",
    async (size) => {
      onTheSixth();
      const server = withAccounts();
      const user = await importing(
        server,
        fileOf(line({ schedule: '"Fortnightly, day 1"', payee: 'Odd' }), line({ payee: 'Water' })),
        size,
      );
      expect(await screen.findByText("Can't read the schedule")).toBeTruthy();
      expect(screen.getByLabelText<HTMLInputElement>('Import row 2').disabled).toBe(true);
      await user.click(await screen.findByRole('button', { name: /^Import / }));
      await waitFor(() => expect(server.recurring).toHaveLength(1));
      expect(server.recurring[0].payee).toBe('Water');
    },
  );

  test('the stand-in refuses a start after tomorrow in UTC, as the server does', async () => {
    const server = withAccounts();
    renderApp(server, '/');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const utcDay = (days: number) =>
      new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
    const send = (startDate: string) =>
      fetch('/api/changes', {
        method: 'POST',
        body: JSON.stringify({
          changes: [
            {
              op: 'addRecurring',
              recurring: { ...repeating({ startDate }), nextDue: undefined, archived: undefined },
            },
          ],
          ids: [(++made).toString(16).padStart(16, '6')],
        }),
      });
    const refused = await send(utcDay(2));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'Give a day from 2000 up to today' });
    expect((await send(utcDay(1))).status).toBe(200);
  });
});
