// The signed-in account: who it is, its display name and its settings

import { Hono } from 'hono';
import type { Profile, ProfilePatch } from '../../shared/api';
import type { AppEnv } from '../app';
import { json, readJson } from '../http';
import { getProfile, patchProfile } from '../accounts/profiles';

const me = new Hono<AppEnv>();

me.get('/me', async (c) => json<Profile>(await getProfile(c.env.DB, c.var.email)));

me.patch('/me', async (c) => {
  const body = await readJson<ProfilePatch>(c.req.raw);
  if (body instanceof Response) return body;
  return patchProfile(c.env.DB, c.var.email, body);
});

export default me;
