// The signed-in account: who it is, its display name and its settings

import { Hono } from 'hono';
import type { Profile, ProfilePatch } from '../../shared/api';
import type { AppEnv } from '../app';
import { json, readJson } from '../http';
import { getProfile, patchProfile } from '../accounts/profiles';
import { queueConversion, restartStalled } from '../currency/convert-queue';

const me = new Hono<AppEnv>();

me.get('/me', async (c) => {
  const profile = await getProfile(c.env.DB, c.var.email);
  // A conversion the queue gave up on starts again once the person is back
  if (profile.conversion != null && profile.conversion.refused == null) {
    c.executionCtx.waitUntil(restartStalled(c.env, c.var.email).catch(() => {}));
  }
  return json<Profile>(profile);
});

me.patch('/me', async (c) => {
  const body = await readJson<ProfilePatch>(c.req.raw);
  if (body instanceof Response) return body;
  return patchProfile(c.env.DB, c.var.email, body, (job) => queueConversion(c.env, job));
});

export default me;
