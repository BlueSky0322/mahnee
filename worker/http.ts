// Small helpers every part of the API uses to answer and to read what it was sent

import type { ApiErrorBody, ErrorCode, Ok } from '../shared/api';

/**
 * Responds with JSON. Every call names the response's type from shared/api.ts
 * (json<Profile>(…)), which the app reads with the same type: without one, the
 * body is `never` and nothing compiles.
 */
export const json = <T = never>(body: NoInfer<T>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
  });

export const ok = () => json<Ok>({ ok: true });

export const fail = (error: string, status: number, code?: ErrorCode) =>
  json<ApiErrorBody>(code == null ? { error } : { error, code }, status);

export const notFound = () => fail('Not found', 404);

/**
 * Whether a request came from a page on another site. Browsers say where a request
 * came from in Sec-Fetch-Site; older ones only in Origin.
 */
export function isCrossSite(req: Request, url: URL): boolean {
  const site = req.headers.get('Sec-Fetch-Site');
  if (site != null) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.get('Origin');
  return origin != null && origin !== url.origin;
}

/**
 * True for a change (not a read) started by another site. The sign-in cookie rides
 * along with such requests, so without this a page elsewhere could post changes on
 * someone's behalf.
 */
export const isCrossSiteWrite = (req: Request, url: URL) =>
  req.method !== 'GET' && req.method !== 'HEAD' && isCrossSite(req, url);

const MAX_BODY_BYTES = 256 * 1024;

/** How long a request may take to send its body before it's turned away */
export const BODY_DEADLINE_MS = 30_000;

/**
 * A request body, read only as far as `limit` bytes: turned away at once when it says it's
 * larger, and as soon as more than that arrives, whatever it said (the header can be
 * missing or wrong), and when it takes longer than `deadline` to arrive. Nothing past
 * the limit is kept or waited for.
 */
export async function readBody(
  req: Pick<Request, 'headers' | 'body'>,
  limit: number,
  deadline = BODY_DEADLINE_MS,
): Promise<Uint8Array | 'too large' | 'too slow'> {
  if (Number(req.headers.get('Content-Length') ?? 0) > limit) return 'too large';
  if (req.body == null) return new Uint8Array();
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'too slow'>((resolve) => {
    timer = setTimeout(() => resolve('too slow'), deadline);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === 'too slow' || size + (next.value?.byteLength ?? 0) > limit) {
        void reader.cancel().catch(() => {});
        return next === 'too slow' ? next : 'too large';
      }
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The answer to a body readBody turned away */
export const bodyRefused = (outcome: 'too large' | 'too slow') =>
  outcome === 'too large' ? fail('Too large', 413) : fail('Took too long to send', 408);

/** A request body as sent: the field names the contract gives, each value still to check */
export type Unchecked<T> = { [K in keyof T]?: unknown };

/** The JSON body of a request, as the fields of T (in shared/api.ts) still to be checked */
export async function readJson<T>(req: Request): Promise<Unchecked<T> | Response> {
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (typeof bytes === 'string') return bodyRefused(bytes);
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (body == null || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    return fail('Invalid JSON', 400);
  }
}
