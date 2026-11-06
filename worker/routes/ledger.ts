// A person's ledger: reading their accounts, categories and transactions and a month's
// totals, what each payee was last filed under, taking all of it out as a file, and
// saving the app's changes to them

import { Hono } from 'hono';
import type { ChangesBody, ExportSummary, Ledger } from '../../shared/api';
import { MAX_CHANGES, PENDING_CHANGES_HEADER, readPendingIds } from '../../shared/api';
import type { AppEnv } from '../app';
import { fail, json, readJson } from '../http';
import { applyChanges } from '../ledger/changes';
import { exportTransactions, readExportSummary } from '../ledger/export';
import { readPayeeCategories } from '../ledger/payees';
import { listTransactions, readLedger } from '../ledger/read';
import { readSummary } from '../ledger/summary';

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

ledger.get('/summary', (c) => {
  const pending = pendingIds(c.req.header(PENDING_CHANGES_HEADER));
  if (pending instanceof Response) return pending;
  return readSummary(c.env.DB, c.var.email, new URL(c.req.url).searchParams, pending);
});

ledger.get('/export', (c) =>
  exportTransactions(c.env.DB, c.var.email, new Date().toISOString().slice(0, 10)),
);

ledger.get('/export/summary', async (c) =>
  json<ExportSummary>(await readExportSummary(c.env.DB, c.var.email)),
);

ledger.get('/payee-categories', (c) =>
  readPayeeCategories(c.env.DB, c.var.email, new URL(c.req.url).searchParams),
);

ledger.post('/changes', async (c) => {
  const body = await readJson<ChangesBody>(c.req.raw);
  if (body instanceof Response) return body;
  return applyChanges(c.env.DB, c.var.email, body);
});

export default ledger;
