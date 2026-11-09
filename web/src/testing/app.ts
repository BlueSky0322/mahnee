// Rendering the whole app in a test (jsdom), against a small in-memory stand-in for the
// API. Screen tests drive it the way a person would: by what's on screen.

// IndexedDB, for the offline cache
import 'fake-indexeddb/auto';
import { cleanup, configure, render } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import { onlineManager } from '@tanstack/react-query';
import { createElement } from 'react';
import { afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import type {
  Account,
  Category,
  ChangesBody,
  LedgerChange,
  MonthSummary,
  MonthTrend,
  Profile,
  Recurring,
  Transaction,
} from '@shared/api';
import {
  DEFAULT_SETTINGS,
  EXPECTED_ACCOUNT_HEADER,
  MAX_CHANGES,
  MAX_PAYEE_CATEGORIES,
  PENDING_CHANGES_HEADER,
  isRowId,
  readPendingIds,
} from '@shared/api';
import {
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  categoriesOrDefaults,
  isCategoryKind,
  nextPosition,
  readCategoryName,
  reorder,
  siblingsOf,
  whyNotUnder,
} from '@shared/categories';
import {
  DEFAULT_CURRENCY,
  MAX_ACCOUNTS,
  MAX_ACCOUNT_NAME,
  MAX_BULK_TRANSACTIONS,
  MAX_NOTE,
  MAX_PAYEE,
  MAX_TRANSACTION,
  MAX_TRANSACTIONS_PER_ACCOUNT,
  balanceEffect,
  fitsOpeningCents,
  fitsTransactionCents,
  isAccountKind,
  isDay,
  isMonth,
  isOnAccount,
  isTransactionKind,
  readAccountName,
  readOptionalText,
  whyNotBetween,
  whyNotInCategory,
  whyNotOnAccount,
} from '@shared/ledger';
import {
  CSV_BOM,
  EXPORT_COLUMNS,
  csvLine,
  exportCells,
  exportFileName,
  openingCells,
} from '@shared/export';
import type { BudgetRow } from '@shared/budgets';
import {
  BUDGET_RANGE,
  fitsBudgetCents,
  isBudgetMonth,
  monthBudgets,
  whyNoBudget,
} from '@shared/budgets';
import { rateDay } from '@shared/rates';
import {
  MAX_RECURRING,
  fallsOn,
  isCalendarDay,
  isSchedule,
  isScheduleDay,
  latestDue,
  nextAfter,
  scheduleDayRange,
} from '@shared/recurring';
import { matchesSearch, readSearch } from '@shared/search';
import { trendMonths } from '@shared/trend';
import { Root } from '../Root';
import { queryClient } from '../query-client';
import { clearCache } from '../offline/cache';

// The whole app renders in each test, which takes a while when every test file runs at
// once: wait longer than the default second for things to appear
configure({ asyncUtilTimeout: 4000 });

/** The screen tests run at: a computer, a tablet or a phone, and how wide each is */
const WIDTHS = { desktop: 1280, tablet: 820, phone: 390 };
let screenSize: keyof typeof WIDTHS = 'desktop';

/** Whether a width query, say "(min-width: 64em)", holds at the screen's width */
function matchesWidth(query: string) {
  const m = /\((min|max)-width:\s*([\d.]+)(em|px)\)/.exec(query);
  if (m == null) return false;
  const px = Number(m[2]) * (m[3] === 'em' ? 16 : 1);
  return m[1] === 'min' ? WIDTHS[screenSize] >= px : WIDTHS[screenSize] <= px;
}

// What jsdom doesn't have, and the app (or Mantine) uses
function stubBrowser() {
  window.matchMedia = (query: string) => ({
    matches: matchesWidth(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
}

/**
 * An account as the stand-in keeps it: as listed, but for its balance, which is worked
 * out, and with when it was added (ms; 0 unless a test says), which only the export shows
 */
type FakeAccount = Omit<Account, 'balanceCents'> & { createdAt?: number };

/** The data the stand-in server holds; tests set it up and read it back */
export interface FakeServer {
  /**
   * Signed out (the sign-in expired) or down: every request is turned away. Unreachable:
   * no request gets there at all, as with no connection.
   */
  health: 'up' | 'signedOut' | 'down' | 'unreachable';
  me: Profile;
  /**
   * 1 `from` is `rate` `to`: today's by `${from}${to}`, an earlier day's by
   * `${from}${to}@2026-10-12`. Asked about a day with none, it's today's, as the real one does.
   */
  rates: Map<string, number>;
  /**
   * The person's accounts as the server keeps them, in the order they were added; a
   * balance is worked out from the opening balance and the transactions, as the real
   * server does
   */
  accounts: FakeAccount[];
  /** The person's transactions as the server keeps them */
  transactions: Transaction[];
  /**
   * The person's categories as the server keeps them: none until their first change,
   * which saves the defaults (shared/categories.ts) with it
   */
  categories: Category[];
  /** The person's repeating items, stopped ones too, in the order they were set up */
  recurring: Recurring[];
  /**
   * The person's budgets as the server keeps them: an amount from a month on (none when
   * null), one row per category and month it was set in
   */
  budgets: BudgetRow[];
  /** Saved change ids and the change each was, as the real server keeps receipts */
  receipts: Map<string, string>;
  /**
   * The next save of the profile, or of ledger changes, answers with this status (and a
   * general explanation), or with this status and explanation
   */
  failNext: Partial<
    Record<'profile' | 'changes' | 'payeeCategories', number | { status: number; error: string }>
  >;
  /**
   * The next ledger changes are saved, but the answer never reaches the app, as when the
   * connection drops on the way back
   */
  loseNext: { changes?: boolean };
  /**
   * Paths answered 500 for as long as they're listed, as when one part of the server is
   * down and the rest still answers
   */
  pathsDown: Set<string>;
  /** Answers being held back until a test releases them (see holdNext) */
  held: { method: string; path: string; release: Promise<void> }[];
}

/**
 * Holds back the answer to the next `method` request for `path`: it's worked out when
 * the request arrives (so it shows the server as it was then) and delivered once
 * `release` is called. For putting answers in a different order than their requests.
 */
export function holdNext(server: FakeServer, method: string, path: string) {
  let release = () => {};
  server.held.push({ method, path, release: new Promise<void>((r) => (release = r)) });
  return { release };
}

const EMAIL = 'ryan@example.com';

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

/**
 * The rate from `from` into `to` at `at`, as the real server finds it: that day's when
 * there's one (from the ECB), else today's (from Wise); null when there's none
 */
function rateOn(server: FakeServer, from: string, to: string, at?: number) {
  const day = at == null ? null : rateDay(at);
  const onDay = day == null ? null : server.rates.get(`${from}${to}@${day}`);
  if (onDay != null) {
    return { rate: onDay, source: 'frankfurter' as const, at: Date.parse(`${day}T12:00:00Z`) };
  }
  const rate = server.rates.get(`${from}${to}`);
  return rate == null ? null : { rate, source: 'wise' as const, at: Date.now() };
}

/** Requests the app has made that the stand-in server hasn't answered yet */
let unanswered = 0;

function serve(server: FakeServer) {
  const answer = answerNow(server);
  const respond = (input: RequestInfo | URL, init?: RequestInit) => {
    const response = answer(input, init);
    const method = init?.method ?? 'GET';
    const path = new URL(input instanceof Request ? input.url : input, 'http://app').pathname;
    const at = server.held.findIndex((h) => h.method === method && h.path === path);
    if (at < 0) return response;
    const [{ release }] = server.held.splice(at, 1);
    return release.then(() => response);
  };
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const response = respond(input, init);
    // Counted alongside, so the app gets its answer exactly as before
    unanswered++;
    void response.then(
      () => unanswered--,
      () => unanswered--,
    );
    return response;
  };
}

/**
 * Waits until the app has nothing under way: no request unanswered, nothing loading or
 * saving, for a few turns in a row (work often waits on the device's storage between
 * requests). Gives up after a few seconds, for an answer a test never releases.
 */
async function settle() {
  if (vi.isFakeTimers()) return;
  const giveUpAt = Date.now() + 3000;
  for (let quiet = 0; quiet < 5 && Date.now() < giveUpAt; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const busy = unanswered > 0 || queryClient.isFetching() > 0 || queryClient.isMutating() > 0;
    quiet = busy ? 0 : quiet + 1;
  }
}

function answerNow(server: FakeServer) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input, 'http://app');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const path = url.pathname;

    if (server.health === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
    if (server.health === 'signedOut') return json({ error: 'Signed out' }, 401);
    if (server.health === 'down') return json({ error: 'Internal error' }, 500);
    // A write made as someone else than who's signed in now changes nothing
    const expected = (init?.headers as Record<string, string> | undefined)?.[
      EXPECTED_ACCOUNT_HEADER
    ];
    if (method !== 'GET' && expected != null && expected !== server.me.email) {
      return json({ error: 'Signed in as someone else.', code: 'account_mismatch' }, 409);
    }
    if (server.pathsDown.has(path)) return json({ error: 'Internal error' }, 500);
    if (path === '/api/me' && method === 'GET') return json(server.me);
    const failing = (kind: keyof FakeServer['failNext']) => {
      const failure = server.failNext[kind];
      delete server.failNext[kind];
      if (failure == null) return null;
      return typeof failure === 'number'
        ? json({ error: 'Something went wrong. Try again in a moment.' }, failure)
        : json({ error: failure.error }, failure.status);
    };
    if (path === '/api/me' && method === 'PATCH') {
      const failure = failing('profile');
      if (failure) return failure;
      const patch = body as Partial<Profile>;
      server.me = {
        ...server.me,
        ...('displayName' in patch ? { displayName: patch.displayName ?? null } : {}),
        settings: { ...server.me.settings, ...patch.settings },
      };
      return json(server.me);
    }
    // A read of balances or totals names the changes the app may have had saved already;
    // the answer says which of them it holds, as the real one does in the same batch
    const pending = readPendingIds(
      (init?.headers as Record<string, string> | undefined)?.[PENDING_CHANGES_HEADER],
    );
    const alreadySaved = () =>
      pending != null && pending.length > 0
        ? { alreadySaved: pending.filter((id) => server.receipts.has(id)) }
        : {};
    if (
      (path === '/api/accounts' || path === '/api/summary' || path === '/api/summary/trend') &&
      pending == null
    ) {
      return json({ error: `Name up to ${MAX_CHANGES} change ids` }, 400);
    }
    if (path === '/api/accounts' && method === 'GET') {
      const accounts = [...server.accounts]
        .sort((a, b) => a.position - b.position)
        .map(({ createdAt: _added, ...a }) => ({ ...a, balanceCents: balanceOf(server, a) }));
      const categories = [...server.categories].sort(
        (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
      );
      // Repeating items only for someone who has any, as the real one answers
      const recurring = server.recurring.length > 0 ? { recurring: server.recurring } : {};
      return json({ accounts, categories, ...recurring, ...alreadySaved() });
    }
    if (path === '/api/transactions' && method === 'GET') {
      const page = listTransactions(server, url.searchParams);
      return Array.isArray(page) ? json({ error: page[1] }, page[0]) : json(page);
    }
    if (path === '/api/search' && method === 'GET') {
      const page = searchTransactions(server, url.searchParams);
      return Array.isArray(page) ? json({ error: page[1] }, page[0]) : json(page);
    }
    if (path === '/api/summary' && method === 'GET') {
      const month = url.searchParams.get('month');
      return isMonth(month)
        ? json({ ...summarize(server, month), ...alreadySaved() })
        : json({ error: 'Give a month from 2000, like 2026-11' }, 400);
    }
    if (path === '/api/summary/trend' && method === 'GET') {
      const month = url.searchParams.get('month');
      return isMonth(month)
        ? json({ ...trendOf(server, month), ...alreadySaved() })
        : json({ error: 'Give a month from 2000, like 2026-11' }, 400);
    }
    if (path === '/api/export/summary' && method === 'GET') {
      const days = server.transactions.map((t) => t.date).sort();
      return json({
        transactions: days.length,
        firstDate: days[0] ?? null,
        lastDate: days.at(-1) ?? null,
        accounts: server.accounts.length,
        categories: server.categories.length,
      });
    }
    if (path === '/api/export' && method === 'GET') return exportFile(server);
    if (path === '/api/payee-categories' && method === 'GET') {
      const failure = failing('payeeCategories');
      if (failure) return failure;
      const filed = payeeCategories(server, url.searchParams.get('account'));
      return Array.isArray(filed) ? json({ error: filed[1] }, filed[0]) : json(filed);
    }
    if (path === '/api/changes' && method === 'POST') {
      const failure = failing('changes');
      if (failure) return failure;
      const refusal = saveChanges(server, body as Partial<ChangesBody>);
      if (refusal != null) return json({ error: refusal[1] }, refusal[0]);
      if (server.loseNext.changes) {
        server.loseNext.changes = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return json({ ok: true });
    }
    if (path === '/api/rates') {
      const [from, to] = [url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''];
      const at = url.searchParams.get('at');
      const found = rateOn(server, from, to, at == null ? undefined : Number(at));
      return found == null
        ? json({ error: 'No rate' }, 503)
        : json({ from, to, rate: found.rate, source: found.source, fetchedAt: found.at });
    }
    return json({ error: `No stand-in for ${method} ${path}` }, 404);
  };
}

/**
 * An account's balance as the real server works it out: opening, plus income and
 * transfers in, less spending and transfers out
 */
const balanceOf = (server: FakeServer, account: Pick<Account, 'id' | 'openingCents'>) =>
  server.transactions.reduce((sum, t) => sum + balanceEffect(t, account.id), account.openingCents);

/**
 * GET /api/summary as the real one (worker/ledger/summary.ts) sums a month: spending and
 * income only (never a transfer), by each category's own id, largest first then by id
 */
function summarize(server: FakeServer, month: string): MonthSummary {
  const totals = (kind: 'expense' | 'income') => {
    const byId = new Map<string, number>();
    for (const t of server.transactions) {
      if (t.kind !== kind || !t.date.startsWith(`${month}-`) || t.categoryId == null) continue;
      byId.set(t.categoryId, (byId.get(t.categoryId) ?? 0) + t.amountCents);
    }
    return [...byId]
      .map(([categoryId, cents]) => ({ categoryId, cents }))
      .sort((a, b) => b.cents - a.cents || (a.categoryId < b.categoryId ? -1 : 1));
  };
  const sum = (list: { cents: number }[]) => list.reduce((all, t) => all + t.cents, 0);
  const spentByCategory = totals('expense');
  const incomeByCategory = totals('income');
  const [spentCents, incomeCents] = [sum(spentByCategory), sum(incomeByCategory)];
  // Budgets as the real one reads them: on categories at the top level now, in their
  // order, with each earlier month's spending under its top-level category
  const byId = new Map(server.categories.map((c) => [c.id, c]));
  const topOf = (id: string | null) => {
    const c = id == null ? undefined : byId.get(id);
    return c == null ? null : c.parentId ?? c.id;
  };
  const rows = server.budgets
    .filter((b) => {
      const c = byId.get(b.categoryId);
      return c != null && whyNoBudget(c) == null;
    })
    .sort((a, b) => {
      const [ca, cb] = [byId.get(a.categoryId)!, byId.get(b.categoryId)!];
      return ca.position - cb.position || (ca.id < cb.id ? -1 : ca.id > cb.id ? 1 : 0);
    });
  const spentIn = (m: string, categoryId: string) =>
    server.transactions
      .filter(
        (t) =>
          t.kind === 'expense' && t.date.startsWith(`${m}-`) && topOf(t.categoryId) === categoryId,
      )
      .reduce((all, t) => all + t.amountCents, 0);
  // A month still to come has none, as the real one says
  const budgets = isBudgetMonth(month) ? monthBudgets(month, rows, spentIn) : [];
  return {
    month,
    incomeCents,
    spentCents,
    leftCents: incomeCents - spentCents,
    spentByCategory,
    incomeByCategory,
    ...(budgets.length > 0 && { budgets }),
  };
}

/**
 * GET /api/summary/trend as the real one (worker/ledger/trend.ts) answers: the 12 months
 * ending at `month`, oldest first, each summed as GET /api/summary sums a month, without
 * its budgets
 */
function trendOf(server: FakeServer, month: string): MonthTrend {
  return {
    month,
    months: trendMonths(month).map((m) => {
      const { budgets: _budgets, ...totals } = summarize(server, m);
      return totals;
    }),
  };
}

/**
 * GET /api/export as the real one (worker/ledger/export.ts) writes it: under a header
 * line, each account's opening balance in the person's order, then every transaction,
 * oldest first (by day, time saved, then id), with names as they are
 */
function exportFile(server: FakeServer) {
  const names = {
    accounts: new Map(server.accounts.map((a) => [a.id, a])),
    categories: new Map(server.categories.map((c) => [c.id, c])),
  };
  const openings = [...server.accounts]
    .sort((a, b) => a.position - b.position)
    .map((a) => csvLine(openingCells({ ...a, createdAt: a.createdAt ?? 0 })));
  const lines = [...server.transactions]
    .sort((a, b) => -newestFirst(a, b))
    .map((t) => csvLine(exportCells(t, names)));
  return Promise.resolve(
    new Response(CSV_BOM + csvLine(EXPORT_COLUMNS) + openings.join('') + lines.join(''), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFileName(rateDay(Date.now()))}"`,
        'Cache-Control': 'no-store',
      },
    }),
  );
}

/**
 * GET /api/payee-categories as the real one (worker/ledger/payees.ts) answers: each
 * payee's latest category per kind, compared ignoring case, the account's own first, then
 * newest first; someone else's account is answered as one that doesn't exist
 */
function payeeCategories(
  server: FakeServer,
  account: string | null,
):
  | { payees: { payee: string; kind: 'expense' | 'income'; categoryId: string }[] }
  | [number, string] {
  if (account == null) return [400, 'Ask for an account'];
  if (!server.accounts.some((a) => a.id === account)) return [404, 'Account not found'];
  const latest = new Map<string, Transaction>();
  const filed = server.transactions
    .filter((t) => t.kind !== 'transfer' && t.payee != null && t.categoryId != null)
    .sort((a, b) =>
      a.accountId === account && b.accountId !== account
        ? -1
        : b.accountId === account && a.accountId !== account
          ? 1
          : newestFirst(a, b),
    );
  for (const t of filed) {
    const key = `${t.kind}|${t.payee!.toLowerCase()}`;
    if (!latest.has(key)) latest.set(key, t);
  }
  return {
    payees: [...latest.values()]
      .sort(newestFirst)
      .slice(0, MAX_PAYEE_CATEGORIES)
      .map((t) => ({
        payee: t.payee!,
        kind: t.kind as 'expense' | 'income',
        categoryId: t.categoryId!,
      })),
  };
}

/** Newest first, as the real server lists them: by day, time saved, then id */
const newestFirst = (a: Transaction, b: Transaction) =>
  b.date.localeCompare(a.date) || b.createdAt - a.createdAt || b.id.localeCompare(a.id);

const cursorOf = (t: Transaction) => `${t.date}_${t.createdAt}_${t.id}`;

/**
 * GET /api/transactions as the real one (worker/ledger/read.ts) answers: an account's
 * (transfers into it too) or a month's, newest first, 50 to a page unless asked (at most 200), carrying on after a
 * cursor; someone else's account is answered as one that doesn't exist
 */
function listTransactions(
  server: FakeServer,
  params: URLSearchParams,
): { transactions: Transaction[]; nextBefore: string | null } | [number, string] {
  const account = params.get('account');
  const month = params.get('month');
  if ((account == null) === (month == null)) return [400, 'Ask for an account or a month'];
  const limit = Number(params.get('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return [400, 'Ask for 1-200'];
  if (account != null && !server.accounts.some((a) => a.id === account)) {
    return [404, 'Account not found'];
  }
  if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [400, 'Give a month'];
  const before = params.get('before');
  if (before != null && !/^\d{4}-\d{2}-\d{2}_\d+_[0-9a-f]{16}$/.test(before)) {
    return [400, 'Unknown place to carry on from'];
  }
  const all = server.transactions
    .filter((t) => (account != null ? isOnAccount(t, account) : t.date.startsWith(`${month}-`)))
    .sort(newestFirst);
  const after = before == null ? all : all.filter((t) => isOlderThan(t, before));
  const transactions = after.slice(0, limit);
  return {
    transactions: transactions.map((t) => ({ ...t })),
    nextBefore: after.length > limit ? cursorOf(transactions[transactions.length - 1]) : null,
  };
}

/**
 * GET /api/search as the real one (worker/ledger/read.ts) answers: what shared/search.ts
 * finds on every account, newest first, 50 to a page unless asked (at most 200), carrying
 * on after a cursor; someone else's account or category is answered as one that doesn't
 * exist
 */
function searchTransactions(
  server: FakeServer,
  params: URLSearchParams,
): { transactions: Transaction[]; nextBefore: string | null } | [number, string] {
  const query = readSearch(params);
  if ('error' in query) return [400, query.error];
  const limit = Number(params.get('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return [400, 'Ask for 1-200'];
  const before = params.get('before');
  if (before != null && !/^\d{4}-\d{2}-\d{2}_\d+_[0-9a-f]{16}$/.test(before)) {
    return [400, 'Unknown place to carry on from'];
  }
  if (query.account != null && !server.accounts.some((a) => a.id === query.account)) {
    return [404, 'Account not found'];
  }
  const categories = categoriesOrDefaults(server.categories);
  if (query.category != null && !categories.some((c) => c.id === query.category)) {
    return [404, 'Category not found'];
  }
  const all = server.transactions
    .filter((t) => matchesSearch(t, query, categories))
    .sort(newestFirst);
  const after = before == null ? all : all.filter((t) => isOlderThan(t, before));
  const transactions = after.slice(0, limit);
  return {
    transactions: transactions.map((t) => ({ ...t })),
    nextBefore: after.length > limit ? cursorOf(transactions[transactions.length - 1]) : null,
  };
}

/** Whether `t` comes after the transaction a cursor names, newest first */
function isOlderThan(t: Transaction, cursor: string) {
  const [date, createdAt, id] = cursor.split('_');
  const named = { date, createdAt: Number(createdAt), id } as Transaction;
  return newestFirst(named, t) < 0;
}

/**
 * POST /api/changes as the real one (worker/ledger/changes.ts) saves a batch: checked in
 * order, all or nothing, a change id saved before counted once. Answers the refusal's
 * status and explanation, or null once saved.
 */
function saveChanges(server: FakeServer, body: Partial<ChangesBody>): [number, string] | null {
  const { changes, ids } = body;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    return [400, `Send 1-${MAX_CHANGES} changes`];
  }
  if (
    !Array.isArray(ids) ||
    ids.length !== changes.length ||
    !ids.every(isRowId) ||
    new Set(ids).size !== ids.length
  ) {
    return [400, 'Send one id of its own for each change'];
  }
  const prints = changes.map((c) => JSON.stringify(c));
  if (ids.some((id, i) => server.receipts.has(id) && server.receipts.get(id) !== prints[i])) {
    return [409, 'That change was saved differently before'];
  }
  // Worked out on a copy, kept only if every change can be saved; a person with no
  // categories saved has the defaults saved with their first change
  const accounts = server.accounts.map((a) => ({ ...a }));
  const categories = categoriesOrDefaults(server.categories);
  const transactions = server.transactions.map((t) => ({ ...t }));
  const recurring = server.recurring.map((r) => ({ ...r }));
  let budgets = server.budgets.map((b) => ({ ...b }));
  const nameError = `Give the account a name of up to ${MAX_ACCOUNT_NAME} characters`;
  const openingError = `An opening balance can be up to ${MAX_TRANSACTION.toLocaleString('en')} either way`;
  for (const [i, change] of changes.entries()) {
    if (server.receipts.has(ids[i])) continue;
    if (
      change.op === 'addCategory' ||
      change.op === 'updateCategory' ||
      change.op === 'archiveCategory'
    ) {
      const refusal = saveCategoryChange(categories, change);
      if (refusal != null) return refusal;
      continue;
    }
    if (
      change.op === 'addTransaction' ||
      change.op === 'updateTransaction' ||
      change.op === 'removeTransaction'
    ) {
      const refusal = saveTransactionChange(accounts, categories, transactions, change);
      if (refusal != null) return refusal;
      continue;
    }
    if (change.op === 'recategoriseTransactions' || change.op === 'removeTransactions') {
      const refusal = saveBulkChange(categories, transactions, change);
      if (refusal != null) return refusal;
      continue;
    }
    if (change.op === 'setBudget') {
      const refusal = checkBudget(categories, change);
      if (refusal != null) return refusal;
      const { categoryId, fromMonth, amountCents, carryOver } = change;
      // From this month on: what was set for later months goes
      budgets = budgets.filter((b) => b.categoryId !== categoryId || b.fromMonth < fromMonth);
      budgets.push({
        categoryId,
        fromMonth,
        amountCents,
        carryOver: amountCents != null && carryOver,
      });
      continue;
    }
    if (
      change.op === 'addRecurring' ||
      change.op === 'updateRecurring' ||
      change.op === 'archiveRecurring' ||
      change.op === 'logRecurring' ||
      change.op === 'skipRecurring'
    ) {
      const refusal = saveRecurringChange(accounts, categories, transactions, recurring, change);
      if (refusal != null) return refusal;
      continue;
    }
    if (change.op === 'addAccount') {
      const { id, name, kind, openingCents } = change.account;
      if (!isRowId(id)) return [400, 'Invalid account id'];
      if (accounts.some((a) => a.id === id)) return [409, 'That account already exists'];
      const checked = readAccountName(name);
      if (checked == null) return [400, nameError];
      if (!isAccountKind(kind)) return [400, 'Unknown kind of account'];
      if (!fitsOpeningCents(openingCents)) return [400, openingError];
      if (accounts.length >= MAX_ACCOUNTS) {
        return [409, `You can have up to ${MAX_ACCOUNTS} accounts, archived ones included`];
      }
      const position = accounts.reduce((last, a) => Math.max(last, a.position + 1), 0);
      accounts.push({
        id,
        name: checked,
        kind,
        currency: DEFAULT_CURRENCY,
        openingCents,
        position,
        archived: false,
        createdAt: Date.now(),
      });
      continue;
    }
    if (change.op !== 'updateAccount' && change.op !== 'archiveAccount') {
      return [400, 'Unknown change'];
    }
    const account = accounts.find((a) => a.id === change.id);
    if (account == null) return [404, 'Account not found'];
    if (change.op === 'archiveAccount') {
      if (typeof change.archived !== 'boolean') return [400, 'Say whether it is archived'];
      account.archived = change.archived;
      continue;
    }
    if (change.name == null && change.openingCents == null) return [400, 'Nothing to change'];
    if (change.name != null) {
      const checked = readAccountName(change.name);
      if (checked == null) return [400, nameError];
      account.name = checked;
    }
    if (change.openingCents != null) {
      if (!fitsOpeningCents(change.openingCents)) return [400, openingError];
      account.openingCents = change.openingCents;
    }
  }
  if (ids.some((id) => !server.receipts.has(id))) {
    server.accounts = accounts;
    server.categories = categories;
    server.transactions = transactions;
    server.recurring = recurring;
    server.budgets = budgets;
  }
  ids.forEach((id, i) => server.receipts.set(id, prints[i]));
  return null;
}

/**
 * One category change, made to `categories` as the real server checks and saves it, or
 * the refusal's status and explanation
 */
function saveCategoryChange(
  categories: Category[],
  change: Extract<LedgerChange, { op: 'addCategory' | 'updateCategory' | 'archiveCategory' }>,
): [number, string] | null {
  const nameError = `Give the category a name of up to ${MAX_CATEGORY_NAME} characters`;
  const find = (id: unknown) => categories.find((c) => c.id === id);
  if (change.op === 'addCategory') {
    const { id, name, kind, parentId } = change.category;
    if (!isRowId(id)) return [400, 'Invalid category id'];
    if (find(id) != null) return [409, 'That category already exists'];
    const checked = readCategoryName(name);
    if (checked == null) return [400, nameError];
    if (!isCategoryKind(kind)) return [400, 'Unknown kind of category'];
    if (parentId != null && find(parentId) == null) return [404, 'Category not found'];
    const reason = whyNotUnder(categories, { id, kind }, parentId);
    if (reason != null) return [409, reason];
    if (categories.length >= MAX_CATEGORIES) {
      return [409, `You can have up to ${MAX_CATEGORIES} categories, archived ones included`];
    }
    const position = nextPosition(siblingsOf(categories, kind, parentId));
    categories.push({ id, name: checked, kind, parentId, position, archived: false });
    return null;
  }
  const category = find(change.id);
  if (category == null) return [404, 'Category not found'];
  if (change.op === 'archiveCategory') {
    if (typeof change.archived !== 'boolean') return [400, 'Say whether it is archived'];
    category.archived = change.archived;
    return null;
  }
  if (change.name === undefined && change.parentId === undefined && change.position == null) {
    return [400, 'Nothing to change'];
  }
  if (change.name !== undefined) {
    const checked = readCategoryName(change.name);
    if (checked == null) return [400, nameError];
    category.name = checked;
  }
  if (change.parentId !== undefined && change.parentId !== category.parentId) {
    if (change.parentId != null && find(change.parentId) == null) {
      return [404, 'Category not found'];
    }
    const reason = whyNotUnder(categories, category, change.parentId);
    if (reason != null) return [409, reason];
    category.position = nextPosition(siblingsOf(categories, category.kind, change.parentId));
    category.parentId = change.parentId;
  }
  if (change.position != null) {
    if (!Number.isSafeInteger(change.position) || change.position < 0) {
      return [400, 'Give a place from 0'];
    }
    const siblings = siblingsOf(categories, category.kind, category.parentId);
    const order = reorder(siblings, category.id, change.position);
    for (const sibling of siblings) sibling.position = order.indexOf(sibling.id);
  }
  return null;
}

/**
 * One transaction change, made to `transactions` as the real server checks and saves it,
 * or the refusal's status and explanation
 */
function saveTransactionChange(
  accounts: FakeAccount[],
  categories: Category[],
  transactions: Transaction[],
  change: Extract<
    LedgerChange,
    { op: 'addTransaction' | 'updateTransaction' | 'removeTransaction' }
  >,
): [number, string] | null {
  const at = transactions.findIndex(
    (t) => t.id === (change.op === 'addTransaction' ? change.transaction.id : change.id),
  );
  if (change.op === 'removeTransaction') {
    if (at < 0) return [404, 'Transaction not found'];
    transactions.splice(at, 1);
    return null;
  }
  if (change.op === 'addTransaction' && at >= 0) return [409, 'That transaction already exists'];
  if (change.op === 'updateTransaction' && at < 0) return [404, 'Transaction not found'];
  const { op: _op, ...given } =
    change.op === 'addTransaction' ? { op: '', ...change.transaction } : change;
  if (Object.keys(given).length === 1) return [400, 'Nothing to change'];
  const before = at >= 0 ? transactions[at] : null;
  const next = {
    // Spending and income go nowhere else, whether or not it's said
    toAccountId: null,
    ...before,
    ...given,
    createdAt: before?.createdAt ?? Date.now(),
  } as Transaction;
  if (!isRowId(next.id)) return [400, 'Invalid transaction id'];
  if (!isTransactionKind(next.kind)) return [400, 'Unknown kind of transaction'];
  const usable = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (account == null) return [404, 'Account not found'] as [number, string];
    const reason = whyNotOnAccount(account);
    return reason == null ? null : ([409, reason] as [number, string]);
  };
  if (before == null || 'accountId' in given) {
    const refusal = usable(next.accountId);
    if (refusal != null) return refusal;
  }
  if (before == null || 'kind' in given || 'accountId' in given || 'toAccountId' in given) {
    if (next.kind !== 'transfer') {
      if (next.toAccountId != null) return [400, 'Only a transfer goes to another account'];
    } else {
      if (next.toAccountId == null) return [400, 'Pick the account it goes to'];
      if (before == null || 'toAccountId' in given) {
        const refusal = usable(next.toAccountId);
        if (refusal != null) return refusal;
      }
      const reason = whyNotBetween(next.accountId, next.toAccountId);
      if (reason != null) return [400, reason];
    }
  }
  // Every account it's newly on needs room for it, transactions on either side counted
  const sides = (t: Transaction | null) => [t?.accountId, t?.toAccountId].filter((a) => a != null);
  for (const id of sides(next).filter((a) => !sides(before).includes(a))) {
    const held = transactions.filter((t) => isOnAccount(t, id) && t.id !== next.id);
    if (held.length >= MAX_TRANSACTIONS_PER_ACCOUNT) {
      return [
        409,
        `An account can hold up to ${MAX_TRANSACTIONS_PER_ACCOUNT.toLocaleString('en')} transactions`,
      ];
    }
  }
  if (before == null || 'kind' in given || 'categoryId' in given) {
    if (next.kind === 'transfer') {
      if (next.categoryId != null) return [400, 'A transfer has no category'];
    } else {
      if (next.categoryId == null) return [400, 'Pick a category'];
      const category = categories.find((c) => c.id === next.categoryId);
      if (category == null) return [404, 'Category not found'];
      const reason = whyNotInCategory(category, next.kind);
      if (reason != null) return [409, reason];
    }
  }
  if (!fitsTransactionCents(next.amountCents)) {
    return [400, `An amount is more than 0 and up to ${MAX_TRANSACTION.toLocaleString('en')}`];
  }
  if (!isDay(next.date)) return [400, 'Give a day from 2000 up to today'];
  const payee = readOptionalText(next.payee, MAX_PAYEE);
  if (payee === undefined) return [400, `A payee can be up to ${MAX_PAYEE} characters`];
  const note = readOptionalText(next.note, MAX_NOTE);
  if (note === undefined) return [400, `A note can be up to ${MAX_NOTE} characters`];
  const saved = { ...next, payee, note };
  if (before == null) transactions.push(saved);
  else transactions[at] = saved;
  return null;
}

/** Why a budget can't be set as the real server checks it, or null when it can */
function checkBudget(
  categories: Category[],
  change: Extract<LedgerChange, { op: 'setBudget' }>,
): [number, string] | null {
  const allowed = ['op', 'categoryId', 'fromMonth', 'amountCents', 'carryOver'];
  const extra = Object.keys(change).find((k) => !allowed.includes(k));
  if (extra != null) return [400, `Unknown field ${extra}`];
  const category = categories.find((c) => c.id === change.categoryId);
  if (category == null) return [404, 'Category not found'];
  const reason = whyNoBudget(category);
  if (reason != null) return [409, reason];
  if (!isBudgetMonth(change.fromMonth)) return [400, 'Give a month from 2000 up to this one'];
  if (change.amountCents !== null && !fitsBudgetCents(change.amountCents)) {
    return [400, BUDGET_RANGE];
  }
  if (typeof change.carryOver !== 'boolean') return [400, 'Say whether it carries over'];
  if (change.amountCents !== null && category.archived) {
    return [409, `${category.name} is archived`];
  }
  return null;
}

/**
 * A change to many transactions, made to `transactions` as the real server checks and
 * saves it (all of them or none), or the refusal's status and explanation
 */
function saveBulkChange(
  categories: Category[],
  transactions: Transaction[],
  change: Extract<LedgerChange, { op: 'recategoriseTransactions' | 'removeTransactions' }>,
): [number, string] | null {
  const allowed = change.op === 'removeTransactions' ? ['op', 'ids'] : ['op', 'ids', 'categoryId'];
  const extra = Object.keys(change).find((k) => !allowed.includes(k));
  if (extra != null) return [400, `Unknown field ${extra}`];
  const { ids } = change as { ids: unknown };
  if (!Array.isArray(ids)) return [400, 'Name the transactions as a list of ids'];
  if (ids.length === 0) return [400, 'Name at least one transaction'];
  if (ids.length > MAX_BULK_TRANSACTIONS) {
    return [400, `Change up to ${MAX_BULK_TRANSACTIONS} transactions at once`];
  }
  if (new Set(ids).size !== ids.length) return [400, 'Name each transaction once'];
  const named = ids.map((id) => transactions.find((t) => t.id === id));
  if (named.some((t) => t == null)) return [404, 'Transaction not found'];
  if (change.op === 'removeTransactions') {
    for (const t of named) transactions.splice(transactions.indexOf(t!), 1);
    return null;
  }
  const category = categories.find((c) => c.id === change.categoryId);
  if (category == null) return [404, 'Category not found'];
  for (const t of named) {
    if (t!.kind === 'transfer') return [400, 'A transfer has no category'];
    const reason = whyNotInCategory(category, t!.kind);
    if (reason != null) return [409, reason];
  }
  for (const t of named) t!.categoryId = category.id;
  return null;
}

/**
 * A change to a repeating item, made to `recurring` (and, logging one, to `transactions`) as
 * the real server checks and saves it, or the refusal's status and explanation
 */
function saveRecurringChange(
  accounts: FakeAccount[],
  categories: Category[],
  transactions: Transaction[],
  recurring: Recurring[],
  change: Extract<
    LedgerChange,
    {
      op:
        | 'addRecurring'
        | 'updateRecurring'
        | 'archiveRecurring'
        | 'logRecurring'
        | 'skipRecurring';
    }
  >,
): [number, string] | null {
  const amountError = `An amount is more than 0 and up to ${MAX_TRANSACTION.toLocaleString('en')}`;
  /** What it would record, checked as a transaction would be */
  const checkAsTransaction = (
    r: Omit<Recurring, 'startDate' | 'nextDue' | 'archived' | 'schedule' | 'day'>,
  ) =>
    saveTransactionChange(accounts, categories, [], {
      op: 'addTransaction',
      transaction: { ...r, note: null, date: rateDay(Date.now()) },
    });
  if (change.op === 'addRecurring') {
    const r = change.recurring;
    if (!isRowId(r.id)) return [400, 'Invalid repeating item id'];
    if (recurring.some((found) => found.id === r.id)) {
      return [409, 'That repeating item already exists'];
    }
    const refusal = checkAsTransaction(r);
    if (refusal != null) return refusal;
    if (!isSchedule(r.schedule)) return [400, 'Repeat monthly or weekly'];
    if (!isScheduleDay(r.schedule, r.day)) return [400, scheduleDayRange(r.schedule)];
    if (!isDay(r.startDate)) return [400, 'Give a day from 2000 up to today'];
    if (recurring.length >= MAX_RECURRING) {
      return [409, `You can have up to ${MAX_RECURRING} repeating items, stopped ones included`];
    }
    const payee = readOptionalText(r.payee, MAX_PAYEE) ?? null;
    recurring.push({
      ...r,
      payee,
      nextDue: nextAfter(r.schedule, r.day, r.startDate),
      archived: false,
    });
    return null;
  }
  const saved = recurring.find((r) => r.id === change.id);
  if (saved == null) return [404, 'Repeating item not found'];
  if (change.op === 'archiveRecurring') {
    if (typeof change.archived !== 'boolean') return [400, 'Say whether it is archived'];
    saved.archived = change.archived;
    return null;
  }
  if (change.op === 'updateRecurring') {
    const { op: _op, id: _id, ...fields } = change;
    if ('kind' in fields) return [400, "A kind can't be changed"];
    if (Object.keys(fields).length === 0) return [400, 'Nothing to change'];
    const next = { ...saved, ...fields };
    if (!fitsTransactionCents(next.amountCents)) return [400, amountError];
    const refusal = checkAsTransaction(next);
    if (refusal != null) return refusal;
    if (!isSchedule(next.schedule)) return [400, 'Repeat monthly or weekly'];
    if (!isScheduleDay(next.schedule, next.day)) return [400, scheduleDayRange(next.schedule)];
    if (('schedule' in fields || 'day' in fields) && !('nextDue' in fields)) {
      return [400, 'Say when it is next due'];
    }
    if (
      !isCalendarDay(next.nextDue) ||
      next.nextDue < '2000-01-01' ||
      !fallsOn(next.schedule, next.day, next.nextDue)
    ) {
      return [400, 'Next due has to fall on its schedule'];
    }
    if (next.nextDue > latestDue()) return [400, 'Next due has to be within a year'];
    Object.assign(saved, next, { payee: readOptionalText(next.payee, MAX_PAYEE) ?? null });
    return null;
  }
  if (saved.archived) return [409, 'That no longer repeats'];
  const account = accounts.find((a) => a.id === saved.accountId);
  if (account?.archived) return [409, `${account.name} is archived`];
  if (change.due !== saved.nextDue) return [409, 'That was logged or skipped already'];
  if (change.op === 'logRecurring') {
    if (change.transaction.date !== change.due) {
      return [400, 'A repeating item is logged on the day it was due'];
    }
    const refusal = saveTransactionChange(accounts, categories, transactions, {
      op: 'addTransaction',
      transaction: change.transaction,
    });
    if (refusal != null) return refusal;
  }
  saved.nextDue = nextAfter(saved.schedule, saved.day, saved.nextDue);
  return null;
}

/** A fresh server with the signed-in account */
export function fakeServer(): FakeServer {
  return {
    health: 'up',
    me: { email: EMAIL, displayName: 'Ryan', settings: { ...DEFAULT_SETTINGS } },
    rates: new Map(),
    accounts: [],
    transactions: [],
    categories: [],
    recurring: [],
    budgets: [],
    receipts: new Map(),
    failNext: {},
    loseNext: {},
    pathsDown: new Set(),
    held: [],
  };
}

/** Renders the app at `path`, talking to `server` */
export function renderApp(
  server: FakeServer,
  path = '/',
  { size = 'desktop' }: { size?: typeof screenSize } = {},
) {
  screenSize = size;
  vi.stubGlobal('innerWidth', WIDTHS[size]);
  vi.stubGlobal('fetch', vi.fn(serve(server)));
  window.history.replaceState(null, '', path);
  return render(createElement(Root));
}

/**
 * Closes the app and opens it again at `path`, as reloading the page does: nothing the
 * page held in memory survives, only what the browser keeps (IndexedDB, localStorage)
 */
export async function reloadApp(
  server: FakeServer,
  path = '/',
  options: { size?: typeof screenSize } = {},
) {
  cleanup();
  await settle();
  vi.resetModules();
  const page = await import('./app');
  // The page opened here is closed with the test, like the first
  onTestFinished(() => page.closeApp());
  return page.renderApp(server, path, options);
}

/** Lets what the app set going finish, and empties what it kept, for the next test */
export async function closeApp() {
  cleanup();
  // What the test set going finishes now, rather than landing in the next test as its data
  await settle();
  queryClient.clear();
  // Messages still showing (an Undo) are kept outside the page; none is left for the next test
  notifications.clean();
  // The device's cache, and whose it is, start empty for the next test
  await clearCache();
}

/** Call in a screen test's file: a browser to render into, emptied between tests */
export function setupAppTests() {
  beforeEach(() => {
    stubBrowser();
    // What the app tries again, it tries again straight away
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
    });
    localStorage.clear();
    sessionStorage.clear();
    // Online, whatever a test before went through: the query cache only hears the
    // connection come back while the app is open
    onlineManager.setOnline(true);
  });
  afterEach(async () => {
    await closeApp();
    vi.unstubAllGlobals();
  });
}
