// A person's ledger: reading their accounts and categories, and saving the app's changes
// to them

import { Hono } from 'hono';
import type { ChangesBody, Ledger } from '../../shared/api';
import type { AppEnv } from '../app';
import { json, readJson } from '../http';
import { applyChanges } from '../ledger/changes';
import { readLedger } from '../ledger/read';

const ledger = new Hono<AppEnv>();

ledger.get('/accounts', async (c) => json<Ledger>(await readLedger(c.env.DB, c.var.email)));

ledger.post('/changes', async (c) => {
  const body = await readJson<ChangesBody>(c.req.raw);
  if (body instanceof Response) return body;
  return applyChanges(c.env.DB, c.var.email, body);
});

export default ledger;
