// The profile picture shown in place of the initial: one the person chose, else a copy of
// their Google picture (unless they asked for the initial), else none. Both are small and
// kept in D1 beside the rest of the account (profile_pictures, migration 0011), served
// only to the account they belong to: the address names no account, so there is no one
// else's to ask for.

import {
  IMAGE_VIEWER_HEADER,
  MAX_PICTURE_BYTES,
  MAX_PICTURE_SIDE,
  type PictureChoice,
  type PictureSource,
} from '../../shared/api';
import { bodyRefused, fail, notFound, readBody } from '../http';

/** Google's picture host; a sign-in's picture is fetched from here and nowhere else */
const GOOGLE_PICTURE_BASE = 'https://lh3.googleusercontent.com/';
/** The size Google is asked for, to match what the app makes of a chosen photo */
const GOOGLE_PICTURE_SIZE = '=s256-c';
/** How long fetching a Google picture may take; past it, the initial shows meanwhile */
const GOOGLE_FETCH_MS = 5000;

/** The image type from the file's first bytes, so a mislabelled file can't pass as one */
function detectType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** A JPEG's size, from its first frame header, without decoding it */
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return [u16be(b, i + 7), u16be(b, i + 5)];
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

/** A picture's width and height from its header, or null when they can't be read */
function imageSize(b: Uint8Array, type: string): [number, number] | null {
  if (type === 'image/jpeg') return jpegSize(b);
  if (type === 'image/png') return b.length >= 24 ? [u32be(b, 16), u32be(b, 20)] : null;
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === 'VP8 ') return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  if (chunk === 'VP8L') {
    return [
      1 + (((b[22] & 0x3f) << 8) | b[21]),
      1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    ];
  }
  if (chunk === 'VP8X') return [1 + u24le(b, 24), 1 + u24le(b, 27)];
  return null;
}

export interface Picture {
  bytes: Uint8Array;
  contentType: string;
}

/** A picture's bytes, checked: a JPEG, PNG or WebP, small, and not too many pixels */
function checkPicture(bytes: Uint8Array): Picture | Response {
  if (bytes.length === 0) return fail('No picture was sent', 400);
  if (bytes.length > MAX_PICTURE_BYTES) return fail('That picture is too large', 413);
  const contentType = detectType(bytes);
  if (contentType == null) return fail('Only JPEG, PNG and WebP pictures', 415);
  // Without a size to read, browsers couldn't show it either: only a size too large is refused
  const size = imageSize(bytes, contentType);
  if (size != null && (size[0] > MAX_PICTURE_SIDE || size[1] > MAX_PICTURE_SIDE)) {
    return fail(`Pictures can be up to ${MAX_PICTURE_SIDE} pixels on a side`, 413);
  }
  return { bytes, contentType };
}

/**
 * Keeps a picture from one source, replacing the one there was. Its version is the time,
 * and always after the one it replaces, so a browser's copy of the old one is never taken
 * for it.
 */
export const keepPictureStatement = (
  db: D1Database,
  email: string,
  source: PictureSource,
  picture: Picture,
  googleUrl: string | null,
) =>
  db
    .prepare(
      `INSERT INTO profile_pictures (email, source, content_type, data, version, google_url)
       VALUES (?1, ?2, ?3, ?4, max(?5, coalesce(
         (SELECT version + 1 FROM profile_pictures WHERE email = ?1 AND source = ?2), 0)), ?6)
       ON CONFLICT (email, source) DO UPDATE SET content_type = excluded.content_type,
         data = excluded.data, version = excluded.version, google_url = excluded.google_url`,
    )
    .bind(email, source, picture.contentType, picture.bytes, Date.now(), googleUrl);

/** PUT /api/me/picture's body: the picture's bytes, checked; or the answer refusing them */
export async function readPicture(req: Request): Promise<Picture | Response> {
  const bytes = await readBody(req, MAX_PICTURE_BYTES);
  if (bytes === 'too large') return fail('That picture is too large', 413);
  if (bytes === 'too slow') return bodyRefused(bytes);
  return checkPicture(bytes);
}

/**
 * PATCH /api/me's picture: the chosen picture goes, and the Google picture (when there is
 * one) or the initial shows. The profile row must exist (ensureProfileStatement first).
 */
export const choosePictureStatements = (db: D1Database, email: string, choice: PictureChoice) => [
  db.prepare("DELETE FROM profile_pictures WHERE email = ? AND source = 'upload'").bind(email),
  db
    .prepare('UPDATE profiles SET google_picture = ?, updated_at = ? WHERE email = ?')
    .bind(choice === 'google' ? 1 : 0, Date.now(), email),
];

export interface PictureRow {
  source: PictureSource;
  version: number;
}

/** Which picture shows, from the account's pictures and whether it wants Google's */
export function shownPicture(rows: PictureRow[], googlePicture: boolean) {
  const upload = rows.find((r) => r.source === 'upload');
  const google = rows.find((r) => r.source === 'google');
  const shown = upload ?? (googlePicture ? google : undefined);
  return {
    picture: shown == null ? null : { source: shown.source, version: shown.version },
    googlePicture: google != null,
  };
}

/** The account's pictures (not their bytes), for getProfile */
export const pictureRowsStatement = (db: D1Database, email: string) =>
  db.prepare('SELECT source, version FROM profile_pictures WHERE email = ?').bind(email);

/** Whether a browser's If-None-Match names `etag` */
const alreadyHas = (req: Request, etag: string) =>
  (req.headers.get('If-None-Match') ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etag || tag === '*');

/**
 * GET /api/me/picture: the signed-in account's own picture, as shown. Browsers keep it
 * but ask each time (private, no-cache), so a change, or someone else signing in on the
 * same browser, is checked by the server before it's shown again; a copy still current is
 * answered without the bytes. X-Image-Viewer tells the service worker whose copy it is.
 */
export async function servePicture(db: D1Database, email: string, req: Request) {
  const [rows, profile] = await db.batch([
    pictureRowsStatement(db, email),
    db.prepare('SELECT google_picture AS google FROM profiles WHERE email = ?').bind(email),
  ]);
  const wantsGoogle = (profile.results[0] as { google: number } | undefined)?.google !== 0;
  const { picture } = shownPicture(rows.results as unknown as PictureRow[], wantsGoogle);
  if (picture == null) return notFound();
  const row = await db
    .prepare(
      `SELECT content_type AS contentType, version, data FROM profile_pictures
       WHERE email = ? AND source = ?`,
    )
    .bind(email, picture.source)
    .first<{ contentType: string; version: number; data: ArrayBuffer | number[] }>();
  if (row == null) return notFound();
  const etag = `"${picture.source}-${row.version}"`;
  const headers = {
    'Cache-Control': 'private, no-cache',
    'ETag': etag,
    [IMAGE_VIEWER_HEADER]: email,
  };
  if (alreadyHas(req, etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(row.data), {
    headers: {
      ...headers,
      'Content-Type': row.contentType,
      // Never treat the bytes as anything but the picture type above
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

/** The address to fetch a sign-in's Google picture at, at 256px; null if it isn't Google's */
function googleAddress(claim: string, base: string): string | null {
  if (!claim.startsWith(base) || claim.length > 2048) return null;
  // Google names the size at the end (=s96-c); without one it's the full size
  const sized = claim.replace(/=s\d+(-c)?$/, '');
  return `${sized}${GOOGLE_PICTURE_SIZE}`;
}

/**
 * The Google picture the sign-in names, fetched and checked, as the statement keeping it;
 * null when the one kept is that one already, or it can't be had. It's copied once, and
 * again only when the sign-in names a different one: the browser never contacts Google,
 * and the copy is served like a chosen picture. One that can't be fetched, or isn't a
 * small picture, is left for the next start.
 */
export async function fetchGooglePicture(
  db: D1Database,
  email: string,
  claim: string,
  base = GOOGLE_PICTURE_BASE,
): Promise<D1PreparedStatement | null> {
  const kept = await db
    .prepare("SELECT google_url AS url FROM profile_pictures WHERE email = ? AND source = 'google'")
    .bind(email)
    .first<{ url: string }>();
  if (kept?.url === claim) return null;
  const address = googleAddress(claim, base);
  if (address == null) return null;
  let res: Response;
  try {
    // Redirects aren't followed: the picture comes from Google's host or not at all
    res = await fetch(address, {
      redirect: 'manual',
      signal: AbortSignal.timeout(GOOGLE_FETCH_MS),
    });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return null;
  }
  const bytes = await readBody(res, MAX_PICTURE_BYTES, GOOGLE_FETCH_MS);
  if (typeof bytes === 'string') return null;
  const picture = checkPicture(bytes);
  if (picture instanceof Response) return null;
  return keepPictureStatement(db, email, 'google', picture, claim);
}
