// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addEntry,
  fakeServer,
  goToPlace,
  openSettings,
  renderApp,
  settle,
  setupAppTests,
} from '../../testing/app';
import { dayText, toDateInput } from '../../utils/date-input';
import { LAST_EMAIL_KEY, clearCache } from '../../offline/cache';
import { navigate } from '../../hooks/useRoute';
import { queryClient } from '../../query-client';
import { handFile } from '../import/handed-file';
import { rememberMapping, rememberedMapping } from '../import/remembered-mapping';
import { pick } from '../../testing/pick';
import { RETRY_DELAY_MS } from '../../ledger/save-queue';

// Import and export (R-Set-Data, R-Desk-Data, R-Empty-Data, R-Desk-Empty-Data): choosing a
// file to import, the imports recorded on the server with Undo for each (D16), the bank
// layouts this device remembers with Forget, and the export: everything (the default),
// this calendar year or picked dates, a file of some dates saying so (D11).

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const CARD = 'b'.repeat(16);
const YEAR = new Date().getFullYear();
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const IMPORTED = 'c'.repeat(16);

/** What an element reads as: its text pieces in order, one space between each */
const text = (el: Element) => {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else node.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

/** A Wallet, an archived card, the default categories, four transactions over two years */
function withHistory() {
  const server = fakeServer();
  const account = {
    kind: 'cash' as const,
    currency: 'MYR',
    openingCents: 0,
    position: 0,
    createdAt: Date.UTC(YEAR - 1, 0, 1),
  };
  server.accounts.push(
    { ...account, id: WALLET, name: 'Wallet', openingCents: 10_000, archived: false },
    { ...account, id: CARD, name: 'Old card', kind: 'card', position: 1, archived: true },
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const seed = (n: number, t: Partial<Transaction>) =>
    server.transactions.push({
      id: n.toString(16).padStart(16, 'd'),
      kind: 'expense',
      accountId: WALLET,
      toAccountId: null,
      amountCents: 800,
      categoryId: categoryId('Food'),
      payee: null,
      note: null,
      date: `${YEAR}-02-10`,
      createdAt: n,
      ...t,
    });
  seed(1, { date: `${YEAR}-03-14` });
  seed(2, { date: `${YEAR - 1}-12-01`, accountId: CARD });
  seed(3, { kind: 'transfer', toAccountId: CARD, categoryId: null });
  seed(4, { date: `${YEAR}-01-03`, categoryId: categoryId('Transport') });
  return server;
}

/** An import the server recorded on Jan 3 this year, its two entries among `server`'s */
function withImport(server: FakeServer, more: Partial<FakeServer['imports'][number]> = {}) {
  server.imports.push({
    id: IMPORTED,
    fileName: 'maybank-oct.csv',
    accountId: WALLET,
    addedCount: 2,
    skippedCount: 1,
    createdAt: new Date(YEAR, 0, 3, 9).getTime(),
    undoneAt: null,
    ...more,
  });
  // The ones it added: Jan 3's and Mar 14's
  server.importIds.set('4'.padStart(16, 'd'), IMPORTED);
  server.importIds.set('1'.padStart(16, 'd'), IMPORTED);
  return server;
}

/** What the app hands the browser to save: each file's name and contents */
function catchDownloads() {
  const saved: { name: string; blob: Blob }[] = [];
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
    saved.push({ name: this.download, blob: blobs.get(this.getAttribute('href') ?? '')! });
  });
  onTestFinished(() => {
    for (const spy of [create, revoke, click]) spy.mockRestore();
  });
  return saved;
}

/** A saved file's lines, the byte-order mark checked and dropped */
async function linesOf(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder().decode(bytes).split('\r\n');
}

/**
 * A bank layout this device remembers for Ryan: kept as his, as the app keeps it once he's
 * signed in (signing in as someone new lets every kept layout go)
 */
function remember(accountId: string, mapping: Parameters<typeof rememberMapping>[2]) {
  localStorage.setItem(LAST_EMAIL_KEY, 'ryan@example.com');
  rememberMapping('ryan@example.com', accountId, mapping);
}

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

const openData = async (server: FakeServer, size: (typeof SIZES)[number] = 'desktop') => {
  renderApp(server, '/?settings=data', { size });
  await screen.findByRole('heading', { name: 'Import and export', level: 1 });
  return userEvent.setup();
};

const exporting = () => within(screen.getByRole('region', { name: 'Export' }));

describe('Import and export', () => {
  test('on a phone: choosing a file, recent imports, banks it remembers, then the export', async () => {
    const server = withImport(withHistory());
    remember(WALLET, {
      date: 'Transaction Date',
      amount: 'Amount (MYR)',
      moneyIn: null,
      moneyOut: null,
      payee: 'Description',
      note: null,
    });
    await openData(server, 'phone');
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(text(screen.getByRole('region', { name: 'Import' }))).toBe(
      "Import A bank's CSV or a Mahnee export. Add the bank's account first. Choose a file",
    );
    expect(screen.getByLabelText('Choose a file')).toHaveProperty('type', 'file');

    const recent = await screen.findByRole('region', { name: 'Recent imports' });
    await waitFor(() =>
      expect(within(recent).getAllByRole('listitem').map(text)).toEqual([
        'maybank-oct.csv Jan 3 · into Wallet · 2 added Undo',
      ]),
    );
    const remembered = screen.getByRole('region', { name: 'Banks it remembers' });
    expect(within(remembered).getAllByRole('listitem').map(text)).toEqual([
      'Wallet Transaction Date, Description, Amount (MYR) Forget',
    ]);

    expect(text(exporting().getByRole('heading', { name: 'Export' }).parentElement!)).toContain(
      'CSV for Excel, Numbers or Google Sheets',
    );
    const which = exporting().getByRole('radiogroup', { name: 'Which entries' });
    expect(
      within(which)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label') ?? text(r)),
    ).toEqual(['Everything', 'This year', 'Pick dates']);
    expect(within(which).getByRole('radio', { name: 'Everything' })).toHaveProperty(
      'checked',
      true,
    );
    expect(
      await exporting().findByText(
        `4 entries · 2 accounts · since ${dayText(`${YEAR - 1}-12-01`)}`,
      ),
    ).toBeTruthy();
    expect(exporting().getByRole('button', { name: 'Download CSV' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  test('on a computer: a drop zone, the counts split out, and what the file holds', async () => {
    const server = withImport(withHistory(), { skippedCount: 4 });
    remember(WALLET, {
      date: 'Posting Date',
      amount: null,
      moneyIn: 'Credit',
      moneyOut: 'Debit',
      payee: 'Merchant',
      note: null,
    });
    await openData(server);
    expect(screen.getByLabelText('Import a file')).toHaveProperty('type', 'file');
    expect(screen.getByText('Or drop a CSV here')).toBeTruthy();
    const recent = await screen.findByRole('region', { name: 'Recent imports' });
    await waitFor(() =>
      expect(within(recent).getAllByRole('listitem').map(text)).toEqual([
        'maybank-oct.csv Jan 3 · into Wallet 2 added, 4 skipped Undo import',
      ]),
    );
    const remembered = screen.getByRole('region', { name: 'Remembered column layouts' });
    expect(within(remembered).getAllByRole('listitem').map(text)).toEqual([
      'Wallet Posting Date, Merchant, Debit, Credit Forget',
    ]);
    await waitFor(() =>
      expect(text(exporting().getByRole('list', { name: 'What the file holds' }))).toBe(
        `Entries 4 From ${dayText(`${YEAR - 1}-12-01`)} to ${dayText(`${YEAR}-03-14`)} ` +
          'Accounts 2 Categories 10, archived ones too',
      ),
    );
  });

  test.each(SIZES)('says when there is nothing yet (%s)', async (size) => {
    const server = fakeServer();
    server.accounts.push({
      id: WALLET,
      name: 'Wallet',
      kind: 'cash',
      currency: 'MYR',
      openingCents: 0,
      position: 0,
      archived: false,
    });
    await openData(server, size);
    expect(await screen.findByText('No imports yet')).toBeTruthy();
    expect(await exporting().findByText('Nothing to export yet')).toBeTruthy();
    expect(exporting().getByRole('button', { name: 'Download CSV' })).toHaveProperty(
      'disabled',
      true,
    );
    // Nothing remembered: no list of banks
    expect(
      screen.queryByRole('region', { name: /^(Banks it remembers|Remembered column layouts)$/ }),
    ).toBeNull();
  });

  test('with no account at all, still offers a file (a Mahnee export brings its own)', async () => {
    await openData(fakeServer(), 'phone');
    expect(await screen.findByText('No imports yet')).toBeTruthy();
    expect(await exporting().findByText('Nothing to export yet')).toBeTruthy();
    expect(exporting().getByRole('button', { name: 'Download CSV' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Choose a file')).toHaveProperty('type', 'file');
  });

  test('Forget lets a bank layout go from this device', async () => {
    const server = withHistory();
    remember(WALLET, {
      date: 'Transaction Date',
      amount: 'Amount (MYR)',
      moneyIn: null,
      moneyOut: null,
      payee: 'Description',
      note: null,
    });
    const user = await openData(server, 'phone');
    const remembered = await screen.findByRole('region', { name: 'Banks it remembers' });
    await user.click(within(remembered).getByRole('button', { name: 'Forget' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Banks it remembers' })).toBeNull(),
    );
    expect(rememberedMapping('ryan@example.com', WALLET)).toBeNull();
  });
});

describe('choosing a file', () => {
  const BANK = 'Date,Description,Amount\r\n05/10/2026,Kopi Corner,-8.00\r\n';

  test('opens the import with that file, ready for its columns (phone)', async () => {
    const server = withHistory();
    const user = await openData(server, 'phone');
    await user.upload(
      screen.getByLabelText('Choose a file'),
      new File([BANK], 'maybank-oct.csv', { type: 'text/csv' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'maybank-oct.csv into Wallet', level: 1 }),
    ).toBeTruthy();
    expect(window.location.search).toBe('?import');
    expect(await screen.findByLabelText('Date')).toBeTruthy();
  });

  test('takes a CSV dropped on a computer', async () => {
    const server = withHistory();
    await openData(server);
    const file = new File([BANK], 'maybank-oct.csv', { type: 'text/csv' });
    fireEvent.drop(screen.getByText('Or drop a CSV here'), { dataTransfer: { files: [file] } });
    expect(
      await screen.findByRole('heading', { name: 'Import maybank-oct.csv', level: 1 }),
    ).toBeTruthy();
    expect(window.location.search).toBe('?import');
  });

  test('handed over and never opened, is gone once they sign out (phone)', async () => {
    const server = withHistory();
    await openData(server, 'phone');
    // Chosen, but the import never opened to take it
    handFile(new File([BANK], 'maybank-oct.csv', { type: 'text/csv' }));
    // Signing out, or someone else signing in, empties what this device keeps
    await act(() => clearCache());
    act(() => navigate('?import'));
    expect(await screen.findByRole('heading', { name: 'Import', level: 1 })).toBeTruthy();
    await settle();
    expect(screen.queryByRole('heading', { name: /maybank-oct\.csv/ })).toBeNull();
    expect(screen.queryByLabelText('Date')).toBeNull();
  });
});

describe('undoing an import', () => {
  test.each(SIZES)(
    'asks, then deletes exactly its entries, everywhere, and no longer lists it (%s)',
    async (size) => {
      const server = withImport(withHistory());
      const user = await openData(server, size);
      const undo = size === 'phone' ? 'Undo' : 'Undo import';
      await user.click(await screen.findByRole('button', { name: undo }));
      const ask = within(await screen.findByRole('dialog', { name: 'Undo maybank-oct.csv?' }));
      expect(
        ask.getByText(
          'Its 2 entries are deleted, on every device. Accounts and categories it added stay.',
        ),
      ).toBeTruthy();
      await user.click(ask.getByRole('button', { name: 'Keep it' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(server.transactions).toHaveLength(4);

      await user.click(screen.getByRole('button', { name: undo }));
      const again = within(await screen.findByRole('dialog', { name: 'Undo maybank-oct.csv?' }));
      await user.click(again.getByRole('button', { name: 'Undo import' }));
      expect(await screen.findByText('No imports yet')).toBeTruthy();
      await waitFor(() =>
        expect(server.transactions.map((t) => t.id).sort()).toEqual(
          ['2'.padStart(16, 'd'), '3'.padStart(16, 'd')].sort(),
        ),
      );
      expect(server.imports[0].undoneAt).toEqual(expect.any(Number));
      // The export counts what's left
      if (size === 'phone') {
        expect(
          await exporting().findByText(
            `2 entries · 2 accounts · since ${dayText(`${YEAR - 1}-12-01`)}`,
            undefined,
            { timeout: 4000 },
          ),
        ).toBeTruthy();
      } else {
        await waitFor(
          () =>
            expect(text(exporting().getByRole('list', { name: 'What the file holds' }))).toMatch(
              /^Entries 2 /,
            ),
          { timeout: 4000 },
        );
      }
    },
  );

  test('offline, is kept and done once back, counted once though its answer was lost', async () => {
    // The clock runs, but the wait before trying again can be skipped
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const server = withImport(withHistory());
    // Accounts and Home seen online first, so they're kept on the phone for offline
    renderApp(server, '/?accounts', { size: 'phone' });
    expect(await screen.findByRole('link', { name: /^Wallet, Cash, 76\.00$/ })).toBeTruthy();
    await openSettings();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('link', { name: /^Import and export / }));
    await screen.findByRole('button', { name: 'Undo' });
    const backOnline = goOffline(server);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    const ask = within(await screen.findByRole('dialog', { name: 'Undo maybank-oct.csv?' }));
    await user.click(ask.getByRole('button', { name: 'Undo import' }));
    // Gone from the list at once, sent once there's a connection
    expect(await screen.findByText('No imports yet')).toBeTruthy();
    expect(server.transactions).toHaveLength(4);
    expect(server.imports[0].undoneAt).toBeNull();

    // Its entries stay in balances until the server has taken them out: this device can't
    // know every entry an import added. Wallet: RM 100.00 less three of RM 8.00
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Home' }));
    await goToPlace('Accounts');
    expect(await screen.findByRole('link', { name: /^Wallet, Cash, 76\.00$/ })).toBeTruthy();

    // Its answer lost on the way back, it's sent again and counts once
    server.loseNext.changes = true;
    backOnline();
    await waitFor(() => expect(server.loseNext.changes).toBe(false));
    // Saved, but its answer was lost: kept, and tried again after the queue's wait
    expect(server.imports[0].undoneAt).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAY_MS));
    expect(server.transactions.map((t) => t.id).sort()).toEqual(
      ['2'.padStart(16, 'd'), '3'.padStart(16, 'd')].sort(),
    );
    // Then the balance follows: the transfer of RM 8.00 is all that's left
    expect(
      await screen.findByRole('link', { name: /^Wallet, Cash, 92\.00$/ }, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/Import not found|was undone/)).toBeNull();
  });

  test('an import made offline and undone before it was sent: recorded, undone, nothing left, in one go', async () => {
    const server = withHistory();
    const user = await openData(server, 'phone');
    await screen.findByLabelText('Choose a file');
    // Offline once what the page asks for has arrived: the accounts to import into
    await settle();
    const backOnline = goOffline(server);
    await user.upload(
      screen.getByLabelText('Choose a file'),
      new File(
        ['Date,Description,Amount\r\n05/02/2026,Kopi Corner,-8.00\r\n06/02/2026,Grab,-20.00\r\n'],
        'wallet-feb.csv',
        { type: 'text/csv' },
      ),
    );
    for (const [label, column] of [
      ['Date', 'Date'],
      ['Amount', 'Amount'],
      ['Payee', 'Description'],
    ]) {
      await pick(user, await screen.findByLabelText(label), column);
    }
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(await screen.findByRole('button', { name: 'Add 2 transactions' }));
    await screen.findByRole('heading', { name: 'Wallet' });

    await openSettings();
    await user.click(screen.getByRole('link', { name: /^Import and export / }));
    const recent = within(await screen.findByRole('region', { name: 'Recent imports' }));
    expect(await recent.findByText('wallet-feb.csv')).toBeTruthy();
    await user.click(recent.getByRole('button', { name: 'Undo' }));
    const ask = within(await screen.findByRole('dialog', { name: 'Undo wallet-feb.csv?' }));
    await user.click(ask.getByRole('button', { name: 'Undo import' }));
    expect(await screen.findByText('No imports yet')).toBeTruthy();
    expect(server.imports).toEqual([]);

    backOnline();
    // Sent in the order made: the import, its entries, then its Undo; none refused
    await waitFor(() => expect(server.imports).toHaveLength(1));
    await waitFor(() => expect(server.imports[0].undoneAt).toEqual(expect.any(Number)));
    expect(server.transactions).toHaveLength(4);
    expect(server.transactions.some((t) => t.payee === 'Kopi Corner' || t.payee === 'Grab')).toBe(
      false,
    );
    const sent = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(screen.queryByText(/Import not found|was undone/)).toBeNull();
  });
});

describe('the stand-in keeps the real contract for imports', () => {
  test('refuses an entry for an import it has not seen (404) or one undone (409)', async () => {
    const server = withImport(withHistory(), { undoneAt: 1 });
    renderApp(server, '/?settings=data');
    await screen.findByRole('heading', { name: 'Import and export', level: 1 });
    const post = (importId: string) =>
      fetch('/api/changes', {
        method: 'POST',
        body: JSON.stringify({
          changes: [
            {
              op: 'addTransaction',
              importId,
              transaction: {
                id: 'e'.repeat(16),
                kind: 'expense',
                accountId: WALLET,
                toAccountId: null,
                amountCents: 100,
                categoryId: categoryId('Food'),
                payee: null,
                note: null,
                date: `${YEAR}-01-05`,
              },
            },
          ],
          ids: ['f'.repeat(16)],
        }),
      });
    const unseen = await post('9'.repeat(16));
    expect([unseen.status, await unseen.json()]).toEqual([404, { error: 'Import not found' }]);
    const undone = await post(IMPORTED);
    expect([undone.status, await undone.json()]).toEqual([
      409,
      { error: 'That import was undone' },
    ]);
    expect(server.transactions).toHaveLength(4);
  });
});

describe('exporting', () => {
  test.each(SIZES)('downloads everything by default, then says when (%s)', async (size) => {
    const server = withHistory();
    const saved = catchDownloads();
    const user = await openData(server, size);
    await exporting().findByText(/^4 entries|^Entries/);
    await user.click(exporting().getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe(`mahnee-${toDateInput(new Date())}.csv`);
    const lines = await linesOf(saved[0].blob);
    expect(lines[0]).toBe(
      'Date,Time,Kind,Account,To account,Amount,Currency,Category,Parent category,Payee,Note,Id',
    );
    expect(lines.slice(1).map((line) => line.split(',').slice(0, 3).join(','))).toEqual([
      `${YEAR - 1}-01-01,,Opening balance`,
      `${YEAR - 1}-01-01,,Opening balance`,
      `${YEAR - 1}-12-01,,Spent`,
      `${YEAR}-01-03,,Spent`,
      `${YEAR}-02-10,,Transfer`,
      `${YEAR}-03-14,,Spent`,
      '',
    ]);
    if (size === 'desktop') {
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      expect(await exporting().findByText(`Last downloaded ${today}`)).toBeTruthy();
    }
  });

  test("someone else signed in on the open page doesn't see the last one's download", async () => {
    const server = withHistory();
    const saved = catchDownloads();
    const user = await openData(server);
    await exporting().findByText(/^4 entries|^Entries/);
    await user.click(exporting().getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(await exporting().findByText(/^Last downloaded /)).toBeTruthy();
    // The page still open, the server now says Ann is signed in
    act(() => {
      queryClient.setQueryData(['me'], {
        ...server.me,
        email: 'ann@example.com',
        displayName: 'Ann',
      });
    });
    await settle();
    expect(exporting().queryByText(/^Last downloaded /)).toBeNull();
    expect(localStorage.getItem('mahnee:lastDownloaded:ann@example.com')).toBeNull();
  });

  test('this year is the calendar year, and its file says it holds only those dates', async () => {
    const server = withHistory();
    const saved = catchDownloads();
    const user = await openData(server, 'phone');
    await exporting().findByText(/^4 entries/);
    await user.click(exporting().getByRole('radio', { name: 'This year' }));
    expect(
      await exporting().findByText(`3 entries · 2 accounts · since ${dayText(`${YEAR}-01-03`)}`),
    ).toBeTruthy();
    await user.click(exporting().getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe(`mahnee-${YEAR}-01-01-to-${YEAR}-12-31.csv`);
    const lines = await linesOf(saved[0].blob);
    expect(lines[1]).toBe(
      `${YEAR}-01-01,,Only these dates,,,,,,,,` +
        `Entries from ${YEAR}-01-01 to ${YEAR}-12-31 only. It can't restore balances on its own.,`,
    );
    expect(lines.slice(2).map((line) => line.split(',').slice(0, 3).join(','))).toEqual([
      `${YEAR}-01-03,,Spent`,
      `${YEAR}-02-10,,Transfer`,
      `${YEAR}-03-14,,Spent`,
      '',
    ]);
  });

  test('picks dates, both days included, and says when they are the wrong way round', async () => {
    const server = withHistory();
    const saved = catchDownloads();
    const user = await openData(server);
    await exporting().findByText(/^Entries/);
    await user.click(exporting().getByRole('radio', { name: 'Pick dates' }));
    fireEvent.change(exporting().getByLabelText('From'), { target: { value: `${YEAR}-02-10` } });
    fireEvent.change(exporting().getByLabelText('To'), { target: { value: `${YEAR}-01-01` } });
    expect(await exporting().findByText('Pick a From day on or before the To day')).toBeTruthy();
    expect(exporting().getByRole('button', { name: 'Download CSV' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(exporting().getByLabelText('To'), { target: { value: `${YEAR}-03-14` } });
    await waitFor(() =>
      expect(text(exporting().getByRole('list', { name: 'What the file holds' }))).toBe(
        `Entries 2 From ${dayText(`${YEAR}-02-10`)} to ${dayText(`${YEAR}-03-14`)} ` +
          'Accounts 2 Categories 1',
      ),
    );
    await user.click(exporting().getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe(`mahnee-${YEAR}-02-10-to-${YEAR}-03-14.csv`);
  });

  test("offline, can't download, and says what is still being saved", async () => {
    const server = withHistory();
    renderApp(server, '/?accounts', { size: 'phone' });
    await screen.findByRole('link', { name: /^Wallet/ });
    const backOnline = goOffline(server);
    await addEntry('8');
    await openSettings();
    await userEvent.setup().click(screen.getByRole('link', { name: /^Import and export( |$)/ }));
    await screen.findByRole('heading', { name: 'Import and export', level: 1 });

    expect(exporting().getByRole('button', { name: 'Connect to download' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      exporting().getByText("1 change still being saved won't be in the file yet."),
    ).toBeTruthy();

    // Once it's saved, the file has it, and says so
    backOnline();
    await waitFor(() => expect(server.transactions).toHaveLength(5));
    expect(await exporting().findByText(/^5 entries/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(exporting().queryByText(/still being saved/)).toBeNull();
    expect(exporting().getByRole('button', { name: 'Download CSV' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  test('saves nothing when the download fails, and says so', async () => {
    const server = withHistory();
    const saved = catchDownloads();
    const user = await openData(server);
    await exporting().findByText(/^Entries/);
    server.health = 'down';
    await user.click(exporting().getByRole('button', { name: 'Download CSV' }));
    expect(await exporting().findByRole('alert')).toHaveProperty(
      'textContent',
      "Couldn't download the file. Try again.",
    );
    expect(saved).toEqual([]);
  });
});
