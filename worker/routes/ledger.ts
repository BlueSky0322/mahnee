// A person's ledger: reading their accounts, and saving the app's changes to them

import { Hono } from 'hono';
import type { AccountList, ChangesBody } from '../../shared/api';
import type { AppEnv } from '../app';
import { json, readJson } from '../http';
import { applyChanges } from '../ledger/changes';
import { listAccounts } from '../ledger/read';

const ledger = new Hono<AppEnv>();

ledger.get('/accounts', async (c) => json<AccountList>(await listAccounts(c.env.DB, c.var.email)));

ledger.post('/changes', async (c) => {
  const body = await readJson<ChangesBody>(c.req.raw);
  if (body instanceof Response) return body;
  return applyChanges(c.env.DB, c.var.email, body);
});

export default ledger;
