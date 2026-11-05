// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';
import { dayText, toDateInput } from '../../utils/date-input';

// Exporting from Home: what the file holds, downloading it, and what stops it.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const CARD = 'b'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

/** A Wallet, an archived card, the default categories and three transactions */
function withHistory() {
  const server = fakeServer();
  const account = { kind: 'cash' as const, currency: 'MYR', openingCents: 0, position: 0 };
  server.accounts.push(
    { ...account, id: WALLET, name: 'Wallet', archived: false },
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
      date: '2026-02-10',
      createdAt: n,
      ...t,
    });
  seed(1, { date: '2026-03-14' });
  seed(2, { date: '2026-01-03', accountId: CARD });
  seed(3, { kind: 'transfer', toAccountId: CARD, categoryId: null });
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

async function openExport() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Export' }));
  return { user, dialog: within(await screen.findByRole('dialog', { name: 'Export' })) };
}

describe('exporting', () => {
  test.each(SIZES)('says what the file holds, then downloads it (%s)', async (size) => {
    const server = withHistory();
    const saved = catchDownloads();
    renderApp(server, '/', { size });
    const { user, dialog } = await openExport();

    // Counted by the server: archived accounts and every day, not just what's on screen
    expect(
      await dialog.findByText(
        `3 transactions from ${dayText('2026-01-03')} to ${dayText('2026-03-14')}, ` +
          '2 accounts, 10 categories',
      ),
    ).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe(`mahnee-${toDateInput(new Date())}.csv`);
    // The server's file as it sent it, the byte-order mark included
    const bytes = new Uint8Array(await saved[0].blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split('\r\n');
    expect(lines[0]).toBe(
      'Date,Kind,Account,To account,Amount,Currency,Category,Parent category,Payee,Note,Id',
    );
    expect(lines.slice(1).map((line) => line.slice(0, 10))).toEqual([
      '2026-01-03',
      '2026-02-10',
      '2026-03-14',
      '',
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  });

  test('says when someone has nothing logged yet', async () => {
    renderApp(fakeServer());
    const { dialog } = await openExport();
    expect(await dialog.findByText('No transactions yet, 0 accounts, 0 categories')).toBeTruthy();
  });

  test("offline, can't download, and says what is still being saved", async () => {
    const server = withHistory();
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    await screen.findByText('Wallet');
    const backOnline = goOffline(server);
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = within(await screen.findByRole('dialog'));
    await user.type(form.getByLabelText('Amount'), '8');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const { dialog } = await openExport();
    expect(dialog.getByRole('button', { name: 'Connect to download' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(dialog.getByText("1 change still being saved won't be in the file yet.")).toBeTruthy();

    // Once it's saved, the file has it, and says so
    backOnline();
    await waitFor(() => expect(server.transactions).toHaveLength(4));
    expect(
      await dialog.findByText(/^4 transactions from /, undefined, { timeout: 4000 }),
    ).toBeTruthy();
    expect(dialog.queryByText(/still being saved/)).toBeNull();
    expect(dialog.getByRole('button', { name: 'Download' })).toHaveProperty('disabled', false);
  });

  test('saves nothing when the download fails, and says so', async () => {
    const server = withHistory();
    const saved = catchDownloads();
    renderApp(server);
    const { user, dialog } = await openExport();
    await dialog.findByText(/^3 transactions/);
    server.health = 'down';
    await user.click(dialog.getByRole('button', { name: 'Download' }));
    expect(await dialog.findByRole('alert')).toHaveProperty(
      'textContent',
      "Couldn't download the file. Try again.",
    );
    expect(saved).toEqual([]);
  });
});
