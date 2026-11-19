// The signed-in account: who it is, its display name, its picture and its settings

import { Hono } from 'hono';
import type { Profile, ProfilePatch } from '../../shared/api';
import type { AppEnv } from '../app';
import { json, readJson } from '../http';
import { copyGooglePicture, getProfile, patchProfile, putPicture } from '../accounts/profiles';
import { servePicture } from '../accounts/pictures';

const me = new Hono<AppEnv>();

me.get('/me', async (c) => {
  // The Google picture the sign-in names is copied once the profile has been sent
  const picture = c.var.googlePicture;
  if (picture != null) {
    c.executionCtx.waitUntil(
      copyGooglePicture(c.env.DB, c.var.email, picture, c.env.GOOGLE_PICTURE_BASE).catch((err) =>
        console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error'),
      ),
    );
  }
  return json<Profile>(await getProfile(c.env.DB, c.var.email));
});

// The signed-in account's own picture, as shown in place of the initial; no one else's
me.get('/me/picture', (c) => servePicture(c.env.DB, c.var.email, c.req.raw));
me.put('/me/picture', (c) => putPicture(c.env.DB, c.var.email, c.req.raw));

me.patch('/me', async (c) => {
  const body = await readJson<ProfilePatch>(c.req.raw);
  if (body instanceof Response) return body;
  return patchProfile(c.env.DB, c.var.email, body);
});

export default me;
