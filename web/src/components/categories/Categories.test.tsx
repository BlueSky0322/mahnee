// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Category } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../../testing/app';

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const OFFLINE = "Offline. Changes are kept on this device and saved when you're back.";

const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const COFFEE = 'e'.repeat(16);

/** The server has the defaults saved, and these besides */
function seed(server: FakeServer, ...more: (Partial<Category> & Pick<Category, 'id' | 'name'>)[]) {
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  for (const c of more) {
    const parent = server.categories.find((p) => p.id === c.parentId);
    server.categories.push({
      kind: parent?.kind ?? 'expense',
      parentId: null,
      position: server.categories.filter((s) => s.parentId === (c.parentId ?? null)).length,
      archived: false,
      ...c,
    });
  }
}

const dialog = () => screen.findByRole('dialog');

/** A kind's list, by its heading */
const section = (title: 'Spending' | 'Income') => screen.findByRole('region', { name: title });

/** The categories a kind's list shows, as read out, in order */
async function shown(title: 'Spending' | 'Income') {
  const found = within(await section(title));
  return found
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((name) => !/^(Move|Add) /.test(name));
}

/** The server's categories under `parentId`, by name, in order */
const savedUnder = (server: FakeServer, parentId: string | null, kind = 'expense') =>
  server.categories
    .filter((c) => c.parentId === parentId && c.kind === kind)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.name);

const openCategories = (server: FakeServer, size: (typeof SIZES)[number] = 'desktop') =>
  renderApp(server, '/?categories', { size });

describe('the categories page', () => {
  test.each(SIZES)('opens from Home with the defaults, and goes back (%s)', async (size) => {
    const server = fakeServer();
    renderApp(server, '/', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('link', { name: 'Categories' }));
    expect(await screen.findByRole('heading', { name: 'Categories', level: 1 })).toBeTruthy();
    // Nothing saved yet: the defaults show, and nothing is sent just for looking
    await waitFor(async () =>
      expect(await shown('Spending')).toEqual([
        'Food',
        'Transport',
        'Groceries',
        'Bills',
        'Shopping',
        'Health',
        'Fun',
        'Other',
      ]),
    );
    expect(await shown('Income')).toEqual(['Salary', 'Other income']);
    expect(server.categories).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(await screen.findByRole('link', { name: 'Categories' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Categories' })).toBeNull();
  });

  test('shows placeholders until the ledger arrives', async () => {
    const server = fakeServer();
    const held = holdNext(server, 'GET', '/api/accounts');
    openCategories(server);
    expect(await screen.findByText('Loading your categories')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Spending' })).toBeNull();
    held.release();
    expect(await section('Spending')).toBeTruthy();
    expect(screen.queryByText('Loading your categories')).toBeNull();
  });

  test.each(SIZES)('adds a subcategory, saving the defaults with it (%s)', async (size) => {
    const server = fakeServer();
    openCategories(server, size);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add spending category' }));
    const form = within(await dialog());
    await user.type(form.getByLabelText('Name'), ' Coffee ');
    await user.selectOptions(form.getByLabelText('Under'), 'Food');
    await user.click(form.getByRole('button', { name: 'Add category' }));

    await waitFor(async () =>
      expect((await shown('Spending')).slice(0, 2)).toEqual(['Food', 'Coffee, in Food']),
    );
    await waitFor(() => expect(savedUnder(server, id('Food'))).toEqual(['Coffee']));
    expect(server.categories).toHaveLength(DEFAULT_CATEGORIES.length + 1);
  });

  test.each(SIZES)('renames a category (%s)', async (size) => {
    const server = fakeServer();
    seed(server);
    openCategories(server, size);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Salary' }));
    const form = within(await dialog());
    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Pay');
    await user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await shown('Income')).toEqual(['Pay', 'Other income']));
    await waitFor(() =>
      expect(savedUnder(server, null, 'income')).toEqual(['Pay', 'Other income']),
    );
  });

  test.each(SIZES)('moves one under another, and back to the top level (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') });
    openCategories(server, size);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Coffee, in Food' }));
    let form = within(await dialog());
    await user.selectOptions(form.getByLabelText('Under'), 'Fun');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Coffee, in Fun' })).toBeTruthy();
    await waitFor(() => expect(savedUnder(server, id('Fun'))).toEqual(['Coffee']));
    expect(savedUnder(server, id('Food'))).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Coffee, in Fun' }));
    form = within(await dialog());
    await user.selectOptions(form.getByLabelText('Under'), 'Top level');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await shown('Spending')).at(-1)).toBe('Coffee'));
    await waitFor(() => expect(savedUnder(server, null).at(-1)).toBe('Coffee'));
  });

  test.each(SIZES)('puts one higher or lower with the arrows (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') });
    server.categories.find((c) => c.name === 'Transport')!.archived = true;
    openCategories(server, size);
    const user = userEvent.setup();

    // The first can't go higher, nor the last lower
    expect(await screen.findByRole('button', { name: 'Move Food up' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Move Other down' })).toHaveProperty(
      'disabled',
      true,
    );
    // Alone under Food, Coffee stays where it is
    expect(screen.getByRole('button', { name: 'Move Coffee up' })).toHaveProperty('disabled', true);

    // Past the listed one beside it, an archived one between them or not
    await user.click(screen.getByRole('button', { name: 'Move Food down' }));
    // Food takes Coffee with it
    await waitFor(async () =>
      expect((await shown('Spending')).slice(0, 4)).toEqual([
        'Groceries',
        'Food',
        'Coffee, in Food',
        'Bills',
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'Move Bills up' }));
    await waitFor(async () =>
      expect((await shown('Spending')).slice(0, 4)).toEqual([
        'Groceries',
        'Bills',
        'Food',
        'Coffee, in Food',
      ]),
    );
    await waitFor(() =>
      expect(savedUnder(server, null).slice(0, 4)).toEqual([
        'Transport',
        'Groceries',
        'Bills',
        'Food',
      ]),
    );
  });

  test('a category with subcategories stays at the top level, and a full one says so', async () => {
    const server = fakeServer();
    const subs = Array.from({ length: 50 }, (_, i) => ({
      id: (i + 1).toString(16).padStart(16, 'd'),
      name: `Bill ${i}`,
      parentId: id('Bills'),
      // All archived, so the list stays short; they still count
      archived: true,
    }));
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') }, ...subs);
    openCategories(server);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Food' }));
    let form = within(await dialog());
    expect(form.getByLabelText('Under')).toHaveProperty('disabled', true);
    expect(form.getByText('Food has subcategories, so it stays at the top level')).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(await screen.findByRole('button', { name: 'Coffee, in Food' }));
    form = within(await dialog());
    const full = form.getByRole('option', { name: 'Bills (full)' });
    expect(full).toHaveProperty('disabled', true);
    expect(form.getByRole('option', { name: 'Fun' })).toHaveProperty('disabled', false);
    // Nothing was sent: there was nothing to change
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/changes')).toBe(false);
  });

  test.each(SIZES)('archives a category, and Undo brings it back (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') });
    openCategories(server, size);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Coffee, in Food' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Coffee, in Food' })).toBeNull(),
    );
    await waitFor(() =>
      expect(server.categories.find((c) => c.id === COFFEE)?.archived).toBe(true),
    );

    expect(await screen.findByText('Archived Coffee')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
    await waitFor(() =>
      expect(server.categories.find((c) => c.id === COFFEE)?.archived).toBe(false),
    );
    expect(screen.queryByRole('button', { name: /^Archived \(/ })).toBeNull();
  });

  test('lists archived ones apart, to bring back', async () => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food'), archived: true });
    server.categories.find((c) => c.name === 'Fun')!.archived = true;
    openCategories(server);
    const user = userEvent.setup();

    expect(await shown('Spending')).not.toContain('Fun');
    await user.click(screen.getByRole('button', { name: 'Archived (2)' }));
    expect(screen.getByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fun, Spending' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Bring back' }));

    await waitFor(async () => expect(await shown('Spending')).toContain('Fun'));
    await waitFor(() =>
      expect(server.categories.find((c) => c.name === 'Fun')?.archived).toBe(false),
    );
    expect(screen.getByRole('button', { name: 'Archived (1)' })).toBeTruthy();
  });

  test.each(SIZES)(
    "puts a refused change back, with the server's explanation (%s)",
    async (size) => {
      const server = fakeServer();
      seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') });
      server.failNext.changes = { status: 409, error: 'Fun is archived' };
      const held = holdNext(server, 'POST', '/api/changes');
      openCategories(server, size);
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Coffee, in Food' }));
      const form = within(await dialog());
      await user.selectOptions(form.getByLabelText('Under'), 'Fun');
      await user.click(form.getByRole('button', { name: 'Save' }));
      // Shown straight away, before the server answers
      expect(await screen.findByRole('button', { name: 'Coffee, in Fun' })).toBeTruthy();

      held.release();
      expect(await screen.findByText('Fun is archived')).toBeTruthy();
      expect(await screen.findByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Coffee, in Fun' })).toBeNull();
      expect(savedUnder(server, id('Food'))).toEqual(['Coffee']);
    },
  );
});

describe('categories offline', () => {
  /** The connection drops: the browser says so, and nothing reaches the server */
  function goOffline(server: FakeServer) {
    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    onTestFinished(() => onLine.mockRestore());
  }

  test.each(SIZES)(
    'a change is kept through a reload, and saved once when back (%s)',
    async (size) => {
      const server = fakeServer();
      openCategories(server, size);
      const user = userEvent.setup();
      await section('Spending');

      goOffline(server);
      await user.click(screen.getByRole('button', { name: 'Add spending category' }));
      const form = within(await dialog());
      await user.type(form.getByLabelText('Name'), 'Coffee');
      await user.selectOptions(form.getByLabelText('Under'), 'Food');
      await user.click(form.getByRole('button', { name: 'Add category' }));
      expect(await screen.findByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
      expect(await screen.findByText(`${OFFLINE} 1 change waiting.`)).toBeTruthy();

      await reloadApp(server, '/?categories', { size });
      expect(await screen.findByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
      expect(await screen.findByText(`${OFFLINE} 1 change waiting.`)).toBeTruthy();
      expect(server.categories).toEqual([]);

      const back = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      onTestFinished(() => back.mockRestore());
      server.health = 'up';
      act(() => void window.dispatchEvent(new Event('online')));
      await waitFor(() => expect(savedUnder(server, id('Food'))).toEqual(['Coffee']));
      expect(server.categories).toHaveLength(DEFAULT_CATEGORIES.length + 1);
      const sent = vi
        .mocked(fetch)
        .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST');
      expect(sent).toHaveLength(1);
      expect(await screen.findByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    },
    15_000,
  );
});
