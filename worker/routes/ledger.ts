// A person's ledger: reading their accounts, categories and transactions (searching them
// too), a month's totals and the 12 months up to it, what each payee was last filed
// under, taking all of it out as a file (or some dates of it), the files imported, and
// saving the app's changes to them

import { Hono } from 'hono';
import type { ChangesBody, ExportSummary, Ledger, RecentImports } from '../../shared/api';
import { MAX_CHANGES, PENDING_CHANGES_HEADER, readPendingIds } from '../../shared/api';
import type { AppEnv } from '../app';
import { fail, json, readJson } from '../http';
import { getRatePreference } from '../accounts/profiles';
import { getRateOn } from '../currency/exchange-rates';
import { applyChanges } from '../ledger/changes';
import { exportTransactions, readExportRange, readExportSummary } from '../ledger/export';
import { readImports } from '../ledger/imports';
import { readPayeeCategories } from '../ledger/payees';
import { listTransactions, readLedger, searchTransactions } from '../ledger/read';
import { readSummary } from '../ledger/summary';
import { readTrend } from '../ledger/trend';

const ledger = new Hono<AppEnv>();

/**
 * The change ids a read names as possibly saved already (PENDING_CHANGES_HEADER), or a
 * refusal when they aren't up to MAX_CHANGES row ids
 */
function pendingIds(header: string | undefined): string[] | Response {
  return readPendingIds(header) ?? fail(`Name up to ${MAX_CHANGES} change ids`, 400);
}

ledger.get('/accounts', async (c) => {
  const pending = pendingIds(c.req.header(PENDING_CHANGES_HEADER));
  if (pending instanceof Response) return pending;
  return json<Ledger>(await readLedger(c.env.DB, c.var.email, pending));
});

ledger.get('/transactions', (c) =>
  listTransactions(c.env.DB, c.var.email, new URL(c.req.url).searchParams),
);

ledger.get('/search', (c) =>
  searchTransactions(c.env.DB, c.var.email, new URL(c.req.url).searchParams),
);

ledger.get('/summary', (c) => {
  const pending = pendingIds(c.req.header(PENDING_CHANGES_HEADER));
  if (pending instanceof Response) return pending;
  return readSummary(c.env.DB, c.var.email, new URL(c.req.url).searchParams, pending);
});

ledger.get('/summary/trend', (c) => {
  const pending = pendingIds(c.req.header(PENDING_CHANGES_HEADER));
  if (pending instanceof Response) return pending;
  return readTrend(c.env.DB, c.var.email, new URL(c.req.url).searchParams, pending);
});

ledger.get('/export', (c) => {
  const range = readExportRange(new URL(c.req.url).searchParams);
  if (range instanceof Response) return range;
  return exportTransactions(c.env.DB, c.var.email, new Date().toISOString().slice(0, 10), range);
});

ledger.get('/export/summary', async (c) => {
  const range = readExportRange(new URL(c.req.url).searchParams);
  if (range instanceof Response) return range;
  return json<ExportSummary>(await readExportSummary(c.env.DB, c.var.email, range));
});

ledger.get('/imports', async (c) => json<RecentImports>(await readImports(c.env.DB, c.var.email)));

ledger.get('/payee-categories', (c) =>
  readPayeeCategories(c.env.DB, c.var.email, new URL(c.req.url).searchParams),
);

ledger.post('/changes', async (c) => {
  const body = await readJson<ChangesBody>(c.req.raw);
  if (body instanceof Response) return body;
  // A change typed in a home currency since left is converted at its day's rate, from
  // where the person prefers rates fetched
  return applyChanges(c.env.DB, c.var.email, body, {
    fetchRate: async (from, to, day) =>
      getRateOn(c.env, from, to, Date.parse(`${day}T12:00:00Z`), {
        prefer: await getRatePreference(c.env.DB, c.var.email),
      }),
  });
});

export default ledger;
