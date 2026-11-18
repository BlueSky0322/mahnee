// The signed-in account: who it is, its display name, its picture and its settings

import { Hono } from 'hono';
import type { Profile, ProfilePatch } from '../../shared/api';
import type { AppEnv } from '../app';
import { json, readJson } from '../http';
import { getMe, patchProfile, putPicture } from '../accounts/profiles';
import { servePicture } from '../accounts/pictures';

const me = new Hono<AppEnv>();

me.get('/me', async (c) =>
  json<Profile>(await getMe(c.env.DB, c.var.email, c.var.googlePicture, c.env.GOOGLE_PICTURE_BASE)),
);

// The signed-in account's own picture, as shown in place of the initial; no one else's
me.get('/me/picture', (c) => servePicture(c.env.DB, c.var.email, c.req.raw));
me.put('/me/picture', (c) => putPicture(c.env.DB, c.var.email, c.req.raw));

me.patch('/me', async (c) => {
  const body = await readJson<ProfilePatch>(c.req.raw);
  if (body instanceof Response) return body;
  return patchProfile(c.env.DB, c.var.email, body);
});

export default me;
