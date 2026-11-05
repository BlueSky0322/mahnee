// Keeps the app on the device so it starts fast, opens offline, installs as an app,
// and doesn't download fonts again:
// - The page itself comes from the network when it answers within a few seconds, and
//   from the copy kept here when it doesn't, fails, or the server is in trouble, so the
//   app opens offline and on a bad connection. When Cloudflare Access asks to sign in
//   again, the kept page opens too, marked so, and the app offers to sign in: that page
//   load (marked with SIGN_IN_PARAM) and Access's own pages are left to the network.
// - The kept page is only replaced once every built file it needs is kept too, along
//   with what the app loads later, as the build lists them in /precache.json. Built
//   files of the newest two versions are kept, so a tab still open on the older one can
//   load what it needs; older ones go.
// - Built files and web fonts never change once made (built files have content hashes
//   in their names), so they're served from here once kept.
// - /api always goes to the network, through Cloudflare Access: nothing the account
//   holds is kept here.
// - Changes made offline are kept by the app (in IndexedDB, web/src/offline/outbox.ts);
//   background sync sends them here when the connection is back, even if the app is
//   closed.
const SHELL = 'mahnee-shell-v1';
const ASSETS = 'mahnee-assets-v1';
const FONTS = 'mahnee-fonts-v1';
const KEEP = [SHELL, ASSETS, FONTS];

/** Every built file the app needs offline, written by the build (web/build/precache.ts) */
const PRECACHE_LIST = '/precache.json';
/** Kept in SHELL beside the page: which built files it and the page before it need */
const SHELL_FILES = '/shell-files';
/**
 * What installing the app reads: the manifest, the icons it names, and the one iPhones use
 * (web/public/manifest.webmanifest and web/index.html; shell.test.ts checks they match).
 * Kept beside the page, so a page opened from here can still be installed properly, with
 * its name, icon and launch screen, when Cloudflare Access or the connection would turn
 * the browser's request for them away.
 */
const INSTALL_FILES = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/icon.svg',
  '/apple-touch-icon.png',
];
/** How long a page may take to come before the kept one is shown instead */
const PAGE_WAIT_MS = 3000;

// Shared with the app, which can't be imported here: keep each the same as its twin
/** OPENED_FROM_DEVICE in web/src/offline/cache.ts */
const OPENED_FROM_DEVICE = 'sf-opened-from-device';
/** OPENED_SIGNED_OUT in web/src/offline/cache.ts: opened from here because Access asked to sign in */
const SIGNED_OUT = 'signed-out';
/** SIGN_IN_PARAM in web/src/offline/cache.ts: a page load going to sign in, left to the browser */
const SIGN_IN_PARAM = 'sign-in';
/** SYNC_TAG in web/src/offline/outbox.ts */
const SYNC_TAG = 'mahnee-outbox';
/**
 * OUTBOX_PREFIX and LOCK_PREFIX in web/src/offline/outbox.ts: each person's outbox is
 * kept under their email, as { email, value } with value the changes in order, each
 * { cid, change }
 */
const OUTBOX_PREFIX = 'outbox:';
const LOCK_PREFIX = 'mahnee-outbox:';
/** SW_USER_KEY in web/src/offline/cache.ts: who the app last said is signed in */
const USER_KEY = 'mahnee:user';
/** CLIENT_ID_HEADER in shared/api.ts */
const CLIENT_ID_HEADER = 'X-Client-Id';
/** EXPECTED_ACCOUNT_HEADER in shared/api.ts: whose a write is, the account it was kept for */
const EXPECTED_ACCOUNT_HEADER = 'X-Expected-Account';
/** MAX_CHANGES and MAX_CHANGES_BYTES in shared/api.ts: how much one request may carry */
const MAX_CHANGES = 200;
const MAX_CHANGES_BYTES = 48 * 1024;

const utf8 = new TextEncoder();

/** The next request's changes, as nextBatch in web/src/offline/outbox.ts picks them */
function nextBatch(queued) {
  let bytes = utf8.encode('{"changes":[],"ids":[]}').length;
  let count = 0;
  for (const q of queued.slice(0, MAX_CHANGES)) {
    bytes +=
      utf8.encode(JSON.stringify(q.change)).length +
      utf8.encode(JSON.stringify(q.cid)).length +
      (count > 0 ? 2 : 0);
    if (count > 0 && bytes > MAX_CHANGES_BYTES) break;
    count++;
  }
  return queued.slice(0, count);
}

/** What's sent for these changes, as changesBody in web/src/offline/outbox.ts makes it */
const changesBody = (batch) => ({
  changes: batch.map((q) => q.change),
  ids: batch.map((q) => q.cid),
});

const isFont = (url) =>
  url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com';

/** A real page, not a sign-in redirect or an error */
const isPage = (response) =>
  response.ok &&
  response.type === 'basic' &&
  !response.redirected &&
  (response.headers.get('Content-Type') ?? '').startsWith('text/html');

/**
 * The server, or something in the way, failing to send the page: better shown the kept
 * one. A sign-in redirect or a refusal (4xx) still goes to the browser, so Access can
 * ask them to sign in again.
 */
const isBroken = (response) =>
  response.status >= 500 ||
  (response.ok &&
    !response.redirected &&
    !(response.headers.get('Content-Type') ?? '').startsWith('text/html'));

/** The built files a page loads as it starts */
const filesOf = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

const sameFiles = (a, b) => a.length === b.length && a.every((file) => b.includes(file));

/** A built file, not a sign-in page or an error sent in its place */
async function fetchFile(file) {
  const res = await fetch(file);
  if (!res.ok || res.type !== 'basic' || res.redirected) {
    throw new Error(`${file} could not be kept (${res.status})`);
  }
  return res;
}

/**
 * The build's list of every built file the app needs offline, or null when this build
 * has none (one from before there was a list). Not reaching it fails, to try again later.
 */
async function precacheList() {
  const res = await fetch(PRECACHE_LIST, { cache: 'no-cache' });
  if (res.status >= 500 || res.redirected || res.type !== 'basic') {
    throw new Error(`The list of files could not be read (${res.status})`);
  }
  const list = res.ok ? await res.json().catch(() => null) : null;
  return Array.isArray(list) && list.every((f) => typeof f === 'string') ? list : null;
}

/** Which built files the kept page and the one before it need, as kept beside it */
async function readRecord(shell) {
  const record = await shell
    .match(SHELL_FILES)
    .then((r) => r?.json())
    .catch(() => null);
  return ['page', 'files', 'previous'].every((key) => Array.isArray(record?.[key])) ? record : null;
}

/**
 * Keeps a page that came from the network, with every built file it needs. The page
 * kept before stays until all of them are kept, so stopping halfway (the connection
 * dropping, the browser closing the worker) still leaves a page that opens offline.
 */
async function secureShell(response) {
  const html = await response.clone().text();
  const shell = await caches.open(SHELL);
  const assets = await caches.open(ASSETS);
  const page = filesOf(html);
  const kept = await shell.match('/');
  const keptHtml = kept ? await kept.text() : null;
  const record = await readRecord(shell);
  // Kept already, with its files
  if (keptHtml === html && record != null && sameFiles(record.page, page)) return;

  const list = await precacheList();
  // A list from another version (a deploy landing in between): try again next time
  if (list != null && !page.every((file) => list.includes(file))) {
    throw new Error('The page and the list of its files are from different versions');
  }
  const files = list ?? page;
  await Promise.all(
    files.map(async (file) => {
      if (!(await assets.match(file))) await assets.put(file, await fetchFile(file));
    }),
  );

  // What the page kept until now needs, for tabs still open on it
  let previous = keptHtml == null ? [] : filesOf(keptHtml);
  if (record != null) previous = sameFiles(record.page, page) ? record.previous : record.files;
  await shell.put('/', response);
  // Fetched while signed in, as the page just was; one that can't be kept now is next time
  await Promise.all(
    INSTALL_FILES.map((file) =>
      fetchFile(file)
        .then((res) => shell.put(file, res))
        .catch(() => undefined),
    ),
  );
  await shell.put(
    SHELL_FILES,
    new Response(JSON.stringify({ page, files, previous }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  // Built files neither version needs: from older versions, or fetched along the way
  const wanted = new Set([...files, ...previous]);
  for (const request of await assets.keys()) {
    if (!wanted.has(new URL(request.url).pathname)) await assets.delete(request);
  }
}

// One page at a time, so two tabs opening at once don't interleave their updates
let keeping = Promise.resolve();
/** Keeps the page (a response no one else reads) and its files, after any being kept */
function keepShell(response) {
  const done = keeping.then(() => secureShell(response));
  keeping = done.catch(() => undefined);
  return done;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch('/')
      .then((res) => (isPage(res) ? keepShell(res) : undefined))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(cacheName, request, accept) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only real files: a sign-in redirect or an error must not be stored
  if (response.ok && accept(response)) cache.put(request, response.clone());
  return response;
}

/**
 * The manifest or an icon from the network, keeping it fresh; the copy kept beside the
 * page when the request fails, or Access (or anything else) answers in its place
 */
async function installFile(event) {
  const { request } = event;
  const network = await fetch(request).catch(() => null);
  if (network != null && network.ok && network.type === 'basic' && !network.redirected) {
    const copy = network.clone();
    event.waitUntil(caches.open(SHELL).then((shell) => shell.put(request, copy)));
    return network;
  }
  const kept = await (await caches.open(SHELL)).match(new URL(request.url).pathname);
  if (kept) return kept;
  if (network == null) throw new TypeError(`${request.url} could not be fetched`);
  return network;
}

/**
 * The kept page, marked so the app knows it opened without the server and doesn't wait
 * long on it (openedFromDevice in web/src/offline/cache.ts)
 */
async function fromDevice(kept, why = 'true') {
  const html = (await kept.text()).replace(
    /<head[^>]*>/i,
    (head) => `${head}<meta name="${OPENED_FROM_DEVICE}" content="${why}">`,
  );
  const headers = new Headers(kept.headers);
  headers.delete('Content-Length');
  return new Response(html, { status: kept.status, statusText: kept.statusText, headers });
}

const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

function page(event) {
  const network = fetch(event.request);
  // A good page is kept, even one that comes too late to be shown. Copied here, first,
  // before the browser reads it.
  event.waitUntil(
    network.then((res) => (isPage(res) ? keepShell(res.clone()) : undefined)).catch(() => {}),
  );
  return pageOrKept(network);
}

async function pageOrKept(network) {
  const kept = await (await caches.open(SHELL)).match('/');
  // Nothing kept yet: whatever the network says, however long it takes
  if (kept == null) return network;
  // Offline, slow, or the server failing: the app is the same page whatever the address
  const answer = await Promise.race([network, wait(PAGE_WAIT_MS)]).catch(() => null);
  // Cloudflare Access wants them to sign in again: the app opens with what it kept, and
  // offers to sign in, rather than nothing until there's a connection good enough to
  if (answer != null && answer.type === 'opaqueredirect') return fromDevice(kept, SIGNED_OUT);
  return answer != null && !isBroken(answer) ? answer : fromDevice(kept);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  if (isFont(url)) {
    event.respondWith(
      cacheFirst(FONTS, event.request, (r) => r.type === 'cors' || r.type === 'basic'),
    );
    return;
  }
  // Signing in and out with Cloudflare Access is left to the browser: never the app's
  // kept page
  if (url.origin !== self.location.origin || url.pathname.startsWith('/cdn-cgi/')) return;

  if (event.request.mode === 'navigate') {
    // Going to sign in: Access answers, never the kept page
    if (url.searchParams.has(SIGN_IN_PARAM)) return;
    event.respondWith(page(event));
  } else if (INSTALL_FILES.includes(url.pathname)) {
    event.respondWith(installFile(event));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(ASSETS, event.request, (r) => r.type === 'basic'));
  }
});

// --- Background sync: sends what the app kept while offline ---------------------------

// idb-keyval's database, where the app keeps its saved copies and unsent changes
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store');
    req.onupgradeneeded = () => req.result.createObjectStore('keyval');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keyval', mode);
    const req = run(tx.objectStore('keyval'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** The same lock the app takes (withOutbox), so a change is never sent twice at once */
const withLock = (email, fn) =>
  self.navigator.locks ? self.navigator.locks.request(`${LOCK_PREFIX}${email}`, fn) : fn();

class TryLater extends Error {}

/**
 * Sends changes `account` kept; the server refuses them if someone else is signed in
 * now. Resolves with whether they were saved (false: refused); throws TryLater to keep
 * them for next time.
 */
async function post(path, body, account) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_ID_HEADER]: 'background-sync',
        [EXPECTED_ACCOUNT_HEADER]: account,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TryLater('No connection');
  }
  // The same rule as isRetryable in web/src/offline/outbox.ts: busy, a problem on the
  // server's side, or signed out. Nothing wrong with what was sent.
  if (res.status === 401 || res.status === 429 || res.status >= 500) {
    throw new TryLater(`HTTP ${res.status}`);
  }
  // Signed out (Cloudflare Access sends a sign-in page): the app sends it once signed in
  if (res.redirected || res.type === 'opaqueredirect') throw new TryLater('Signed out');
  const answer = await res.json().catch(() => null);
  // Made as another account than the one signed in now: kept for that account, as
  // isOtherAccount in web/src/offline/outbox.ts says
  if (answer?.code === 'account_mismatch') throw new TryLater('Signed in as someone else');
  // Answered by something other than the API (a proxy, say), as the app sees it too:
  // anything that isn't JSON, or is JSON null
  if (res.ok && answer == null) throw new TryLater('Not answered with JSON');
  // Otherwise saved, or refused (4xx): the app shows the ledger as the server has it
  return res.ok;
}

/** Sends the signed-in account's changes, in order; nobody else's */
async function sendOutbox() {
  const db = await openDb();
  try {
    const user = await idb(db, 'readonly', (s) => s.get(USER_KEY));
    if (typeof user !== 'string') return;
    const key = `${OUTBOX_PREFIX}${user}`;
    await withLock(user, async () => {
      // Read under the lock, in case the app sent them meanwhile
      const entry = await idb(db, 'readonly', (s) => s.get(key));
      if (entry?.email !== user || !Array.isArray(entry.value)) return;
      // As many at a time as the server takes. Each request's changes are crossed off
      // once saved, so a failure later on leaves only what wasn't sent.
      let left = entry.value;
      while (left.length > 0) {
        const batch = nextBatch(left);
        const saved = await post('/api/changes', changesBody(batch), entry.email);
        // Refused: the rest was made on top of it, so it goes too
        left = saved ? left.slice(batch.length) : [];
        const now = left;
        await idb(db, 'readwrite', (s) =>
          now.length > 0 ? s.put({ ...entry, value: now }, key) : s.delete(key),
        );
      }
    });
  } finally {
    db.close();
  }
}

self.addEventListener('sync', (event) => {
  // Failing makes the browser try again later
  if (event.tag === SYNC_TAG) event.waitUntil(sendOutbox());
});
