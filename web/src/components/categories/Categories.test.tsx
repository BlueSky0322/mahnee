// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Category } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  OFFLINE_NOTICE,
  fakeServer,
  holdNext,
  openSettings,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../../testing/app';
import { outboxKey } from '../../offline/outbox';
import { thisMonth } from '../../utils/date-input';
import { openPicker, pick } from '../../testing/pick';

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;

/** What's still waiting on this device for Ryan, as kept there */
const keptForRyan = async () =>
  (await get<{ email: string; value: unknown[] }>(outboxKey('ryan@example.com')))?.value ?? [];

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

type Kind = 'Expenses' | 'Income';

/** A kind's list, by its heading */
const section = (title: Kind) => screen.findByRole('region', { name: title });

/**
 * The categories a kind's list shows, in order: each top-level one by its name, and each
 * subcategory chip under it as "Coffee, in Food"
 */
async function shown(title: Kind) {
  const found = within(await section(title));
  return found
    .getAllByRole('button')
    .filter(
      (b) =>
        !/^(Move|Add|Reorder|Done|Archived)\b/.test(b.textContent ?? '') &&
        !/^(Move|Add) /.test(b.getAttribute('aria-label') ?? ''),
    )
    .map((b) => {
      const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
      const under = b.closest('[role="list"]')?.getAttribute('aria-label');
      return under?.startsWith('Under ') ? `${name}, in ${under.slice('Under '.length)}` : name;
    });
}

/** The server's categories under `parentId`, by name, in order */
const savedUnder = (server: FakeServer, parentId: string | null, kind = 'expense') =>
  server.categories
    .filter((c) => c.parentId === parentId && c.kind === kind)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.name);

const openCategories = (server: FakeServer, size: (typeof SIZES)[number] = 'desktop') =>
  renderApp(server, '/?categories', { size });

/** A subcategory chip, as it's listed under its category */
const chip = async (name: string, parent: string) =>
  within(await screen.findByRole('list', { name: `Under ${parent}` })).findByRole('button', {
    name,
  });

/** Reorder mode, where the arrows are */
async function reorder() {
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Reorder' }));
}

describe('the categories page', () => {
  test.each(SIZES)('opens from Settings with the defaults, and goes back (%s)', async (size) => {
    const server = fakeServer();
    renderApp(server, '/', { size });
    const user = userEvent.setup();

    await openSettings();
    await user.click(screen.getByRole('link', { name: /^Categories( |$)/ }));
    expect(await screen.findByRole('heading', { name: 'Categories', level: 1 })).toBeTruthy();
    // Nothing saved yet: the defaults show, and nothing is sent just for looking
    await waitFor(async () =>
      expect(await shown('Expenses')).toEqual([
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
    // What it starts with, said here rather than on the first run
    expect(
      screen.getByText('Comes with 8 expense and 2 income categories. Edit them any time.'),
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'New expense category' })).toHaveProperty(
      'placeholder',
      'New expense category',
    );
    expect(screen.getByRole('textbox', { name: 'New income category' })).toBeTruthy();
    // No arrows until Reorder
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(server.categories).toEqual([]);

    if (size === 'phone') {
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      expect(await screen.findByRole('link', { name: /^Categories / })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Categories' })).toBeNull();
      expect(window.location.search).toBe('?settings');
    }
  });

  test('shows placeholders until the ledger arrives', async () => {
    const server = fakeServer();
    const held = holdNext(server, 'GET', '/api/accounts');
    openCategories(server);
    expect(await screen.findByText('Loading your categories')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Expenses' })).toBeNull();
    held.release();
    expect(await section('Expenses')).toBeTruthy();
    expect(screen.queryByText('Loading your categories')).toBeNull();
  });

  test.each(SIZES)(
    "shows a budget beside its category, in whole ringgit where it's whole (%s)",
    async (size) => {
      const server = fakeServer();
      seed(server);
      const month = thisMonth();
      server.budgets.push(
        { categoryId: id('Food'), fromMonth: month, amountCents: 80_000, carryOver: false },
        { categoryId: id('Transport'), fromMonth: month, amountCents: 12_050, carryOver: false },
      );
      openCategories(server, size);
      const food = (await screen.findByRole('button', { name: 'Food' })).closest('li')!;
      await waitFor(() => expect(within(food).getByText('RM 800 a month')).toBeTruthy());
      const transport = screen.getByRole('button', { name: 'Transport' }).closest('li')!;
      expect(within(transport).getByText('RM 120.50 a month')).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'adds a subcategory in place, saving the defaults with it (%s)',
    async (size) => {
      const server = fakeServer();
      openCategories(server, size);
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Add a subcategory under Food' }));
      const field = screen.getByRole('textbox', { name: 'New under Food' });
      expect(document.activeElement).toBe(field);
      expect(screen.getByText(/^counts toward Food's budget$/i)).toBeTruthy();
      await user.type(field, ' Bubble tea ');
      await user.click(screen.getByRole('button', { name: 'Add Bubble tea under Food' }));

      expect(await chip('Bubble tea', 'Food')).toBeTruthy();
      await waitFor(async () =>
        expect((await shown('Expenses')).slice(0, 3)).toEqual([
          'Food',
          'Bubble tea, in Food',
          'Transport',
        ]),
      );
      await waitFor(() => expect(savedUnder(server, id('Food'))).toEqual(['Bubble tea']));
      expect(server.categories).toHaveLength(DEFAULT_CATEGORIES.length + 1);

      // With one already, the + sits after the chips; Enter adds too
      await user.click(screen.getByRole('button', { name: 'Add a subcategory under Food' }));
      await user.type(screen.getByRole('textbox', { name: 'New under Food' }), 'Coffee{Enter}');
      expect(await chip('Coffee', 'Food')).toBeTruthy();
      await waitFor(() => expect(savedUnder(server, id('Food'))).toEqual(['Bubble tea', 'Coffee']));
    },
  );

  test('an income subcategory counts toward no budget', async () => {
    openCategories(fakeServer(), 'phone');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a subcategory under Salary' }));
    expect(screen.getByRole('textbox', { name: 'New under Salary' })).toBeTruthy();
    expect(screen.queryByText(/counts toward/i)).toBeNull();
  });

  test.each(SIZES)(
    'adds a top-level category of each kind from its own field (%s)',
    async (size) => {
      const server = fakeServer();
      seed(server);
      openCategories(server, size);
      const user = userEvent.setup();

      const expense = await screen.findByRole('textbox', { name: 'New expense category' });
      // Nothing typed adds nothing
      await user.type(expense, '   {Enter}');
      await user.type(expense, 'Pets{Enter}');
      await waitFor(async () => expect((await shown('Expenses')).at(-1)).toBe('Pets'));
      expect(expense).toHaveProperty('value', '');
      await user.type(
        screen.getByRole('textbox', { name: 'New income category' }),
        'Freelance{Enter}',
      );
      await waitFor(async () =>
        expect(await shown('Income')).toEqual(['Salary', 'Other income', 'Freelance']),
      );
      await waitFor(() => expect(savedUnder(server, null).at(-1)).toBe('Pets'));
      expect(savedUnder(server, null, 'income')).toEqual(['Salary', 'Other income', 'Freelance']);
      expect(server.categories).toHaveLength(DEFAULT_CATEGORIES.length + 2);
    },
  );

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

    await user.click(await chip('Coffee', 'Food'));
    let form = within(await dialog());
    await pick(user, form.getByLabelText('Under'), 'Fun');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await chip('Coffee', 'Fun')).toBeTruthy();
    await waitFor(() => expect(savedUnder(server, id('Fun'))).toEqual(['Coffee']));
    expect(savedUnder(server, id('Food'))).toEqual([]);

    await user.click(await chip('Coffee', 'Fun'));
    form = within(await dialog());
    await pick(user, form.getByLabelText('Under'), 'Top level');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await shown('Expenses')).at(-1)).toBe('Coffee'));
    await waitFor(() => expect(savedUnder(server, null).at(-1)).toBe('Coffee'));
  });

  test.each(SIZES)('puts one higher or lower with the arrows, in Reorder (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') });
    server.categories.find((c) => c.name === 'Transport')!.archived = true;
    openCategories(server, size);
    const user = userEvent.setup();
    await reorder();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();

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
      expect((await shown('Expenses')).slice(0, 4)).toEqual([
        'Groceries',
        'Food',
        'Coffee, in Food',
        'Bills',
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'Move Bills up' }));
    await waitFor(async () =>
      expect((await shown('Expenses')).slice(0, 4)).toEqual([
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
    // Done puts the arrows away
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
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

    await user.click(await chip('Coffee', 'Food'));
    form = within(await dialog());
    const under = await openPicker(user, form.getByLabelText('Under'));
    const full = under.getByRole('option', { name: 'Bills (full)' });
    expect(full.getAttribute('aria-disabled')).toBe('true');
    expect(under.getByRole('option', { name: 'Fun' }).getAttribute('aria-disabled')).toBeNull();
    // Tapping the full one picks nothing, and leaves the list open
    await user.click(full);
    expect(under.getByRole('option', { name: 'Fun' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // Nothing was sent: there was nothing to change
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/changes')).toBe(false);
  });

  test.each(SIZES)('archives a category, and Undo brings it back (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food') });
    openCategories(server, size);
    const user = userEvent.setup();

    await user.click(await chip('Coffee', 'Food'));
    await user.click(within(await dialog()).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Under Food' })).toBeNull());
    await waitFor(() =>
      expect(server.categories.find((c) => c.id === COFFEE)?.archived).toBe(true),
    );

    expect(await screen.findByText('Archived Coffee')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await chip('Coffee', 'Food')).toBeTruthy();
    await waitFor(() =>
      expect(server.categories.find((c) => c.id === COFFEE)?.archived).toBe(false),
    );
    // None archived: nothing to list
    expect(screen.queryByRole('button', { name: 'Archived' })).toBeNull();
  });

  test('lists archived ones apart, to bring back', async () => {
    const server = fakeServer();
    seed(server, { id: COFFEE, name: 'Coffee', parentId: id('Food'), archived: true });
    server.categories.find((c) => c.name === 'Fun')!.archived = true;
    openCategories(server);
    const user = userEvent.setup();

    expect(await shown('Expenses')).not.toContain('Fun');
    const archived = screen.getByRole('button', { name: 'Archived' });
    expect(archived.getAttribute('aria-expanded')).toBe('false');
    await user.click(archived);
    expect(archived.getAttribute('aria-expanded')).toBe('true');
    const list = within(screen.getByRole('region', { name: 'Archived categories' }));
    expect(list.getByRole('button', { name: 'Coffee, in Food' })).toBeTruthy();
    await user.click(list.getByRole('button', { name: 'Fun, Expenses' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Bring back' }));

    await waitFor(async () => expect(await shown('Expenses')).toContain('Fun'));
    await waitFor(() =>
      expect(server.categories.find((c) => c.name === 'Fun')?.archived).toBe(false),
    );
    expect(screen.getByRole('button', { name: 'Archived' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fun, Expenses' })).toBeNull();
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

      await user.click(await chip('Coffee', 'Food'));
      const form = within(await dialog());
      await pick(user, form.getByLabelText('Under'), 'Fun');
      await user.click(form.getByRole('button', { name: 'Save' }));
      // Shown straight away, before the server answers
      expect(await chip('Coffee', 'Fun')).toBeTruthy();

      held.release();
      expect(await screen.findByText('Fun is archived')).toBeTruthy();
      expect(await chip('Coffee', 'Food')).toBeTruthy();
      expect(screen.queryByRole('list', { name: 'Under Fun' })).toBeNull();
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
      await section('Expenses');

      goOffline(server);
      await user.click(screen.getByRole('button', { name: 'Add a subcategory under Food' }));
      await user.type(screen.getByRole('textbox', { name: 'New under Food' }), 'Coffee{Enter}');
      expect(await chip('Coffee', 'Food')).toBeTruthy();
      expect(await screen.findByText(OFFLINE_NOTICE[size])).toBeTruthy();
      // The foot of the page says it waits, and the device keeps it
      expect(await screen.findByText('Mahnee · Offline · 1 change waiting to save')).toBeTruthy();
      await waitFor(async () => expect(await keptForRyan()).toHaveLength(1));

      await reloadApp(server, '/?categories', { size });
      expect(await chip('Coffee', 'Food')).toBeTruthy();
      expect(await screen.findByText(OFFLINE_NOTICE[size])).toBeTruthy();
      expect(await screen.findByText('Mahnee · Offline · 1 change waiting to save')).toBeTruthy();
      expect(await keptForRyan()).toHaveLength(1);
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
      expect(await chip('Coffee', 'Food')).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    },
    15_000,
  );
});
