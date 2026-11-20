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
// - The profile picture is private: online it always comes from the server, which
//   checks who's asking (the browser's own copy answers when the server says it's
//   unchanged). It's kept for the account it was shown to, and shown from here only
//   offline, or while the server is failing, and only to that account.
// - The rest of /api always goes to the network, through Cloudflare Access: nothing else
//   the account holds is kept here.
// - Changes made offline are kept by the app (in IndexedDB, web/src/offline/outbox.ts);
//   background sync sends them here when the connection is back, even if the app is
//   closed. A change the server refuses is kept, marked with why, with the changes held
//   with it, for the person to review in the app; the rest are still sent.
// - Reminders the server pushes (worker/push/reminders.ts) are shown as notifications,
//   and a tap opens the app at the page the reminder points to.
const SHELL = 'mahnee-shell-v1';
const ASSETS = 'mahnee-assets-v1';
const FONTS = 'mahnee-fonts-v1';
const KEEP = [SHELL, ASSETS, FONTS];
/**
 * IMAGE_CACHE_PREFIX in web/src/offline/cache.ts, which clears them on sign-out: one
 * cache per account, named with its email
 */
const IMAGE_CACHE_PREFIX = 'mahnee-pictures-v1:';
/** IMAGE_VIEWER_HEADER in shared/api.ts: whose a picture is, as the server sent it */
const IMAGE_VIEWER_HEADER = 'X-Image-Viewer';
/** PICTURE_PATH in shared/api.ts: the profile picture, always asked for with ?v= */
const PICTURE_PATH = '/api/me/picture';

/** Every built file the app needs offline, written by the build (web/build/precache.ts) */
const PRECACHE_LIST = '/precache.json';
/** Kept in SHELL beside the page: which built files it and the page before it need */
const SHELL_FILES = '/shell-files';
/**
 * What installing the app reads: the manifest, the icons it names, the one iPhones use and
 * the browser tab's (web/public/manifest.webmanifest and web/index.html; shell.test.ts
 * checks they match).
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
  '/favicon-16.png',
  '/favicon-32.png',
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
 * { cid, change, currency?, group?, refused? }
 */
const OUTBOX_PREFIX = 'outbox:';
const LOCK_PREFIX = 'mahnee-outbox:';
/** REFUSED_REASON in web/src/offline/outbox.ts: why a change was refused, when the server didn't say */
const REFUSED_REASON = "The server couldn't save this change.";
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

/** The group a change was made in, as groupOf in web/src/offline/outbox.ts */
const groupOf = (q) => q.group ?? q.cid;
const groupsIn = (batch) => new Set(batch.map(groupOf)).size;

/** The next request's changes, as nextBatch in web/src/offline/outbox.ts picks them */
function nextBatch(queued, maxGroups = Infinity) {
  let bytes = utf8.encode('{"changes":[],"ids":[],"currencies":[]}').length;
  let count = 0;
  const groups = new Set();
  for (const q of queued.slice(0, MAX_CHANGES)) {
    if (!groups.has(groupOf(q)) && groups.size >= maxGroups) break;
    bytes +=
      utf8.encode(JSON.stringify(q.change)).length +
      utf8.encode(JSON.stringify(q.cid)).length +
      utf8.encode(JSON.stringify(q.currency ?? null)).length +
      (count > 0 ? 3 : 0);
    if (count > 0 && bytes > MAX_CHANGES_BYTES) break;
    groups.add(groupOf(q));
    count++;
  }
  return queued.slice(0, count);
}

/** What a change adds, by id, as addedBy in web/src/offline/outbox.ts */
const addedBy = (change) =>
  ['account', 'category', 'transaction', 'recurring', 'import']
    .map((key) => change[key]?.id)
    .filter((id) => typeof id === 'string');

/** TARGETS in web/src/offline/outbox.ts: what a change to an existing thing changes */
const TARGETS = {
  updateAccount: 'account',
  archiveAccount: 'account',
  updateCategory: 'category',
  archiveCategory: 'category',
  updateTransaction: 'transaction',
  removeTransaction: 'transaction',
  recategoriseTransactions: 'transaction',
  removeTransactions: 'transaction',
  updateRecurring: 'recurring',
  archiveRecurring: 'recurring',
  logRecurring: 'recurring',
  skipRecurring: 'recurring',
  undoImport: 'import',
};

/** The things a change adds or changes, as targetsOf in web/src/offline/outbox.ts finds them */
function targetsOf(change) {
  const found = [];
  const kind = TARGETS[change.op];
  if (kind != null && typeof change.id === 'string') found.push(`${kind}:${change.id}`);
  if (kind != null && Array.isArray(change.ids)) {
    for (const id of change.ids) if (typeof id === 'string') found.push(`${kind}:${id}`);
  }
  if (change.op === 'setBudget' && typeof change.categoryId === 'string') {
    found.push(`budget:${change.categoryId}`);
  }
  for (const key of ['account', 'category', 'transaction', 'recurring', 'import']) {
    const id = change[key]?.id;
    if (typeof id === 'string') found.push(`${key}:${id}`);
  }
  return found;
}

/** A change as the app keeps it, as isQueued in web/src/offline/outbox.ts reads it */
const isQueued = (q) =>
  typeof q === 'object' &&
  q != null &&
  typeof q.cid === 'string' &&
  typeof q.change?.op === 'string';

/** Whether a change names any of these ids anywhere in it */
function names(value, ids) {
  if (typeof value === 'string') return ids.has(value);
  if (Array.isArray(value)) return value.some((v) => names(v, ids));
  if (typeof value === 'object' && value != null) {
    return Object.values(value).some((v) => names(v, ids));
  }
  return false;
}

/**
 * The changes held with refused ones, as heldWith in web/src/offline/outbox.ts finds them:
 * those, the rest of their groups, every later change naming something they add, and
 * every later change to the same thing
 */
function heldWith(queued, refused) {
  const held = new Set();
  const groups = new Set();
  const added = new Set();
  const touched = new Set();
  for (const q of queued) {
    if (!isQueued(q) || q.refused != null) continue;
    const targets = targetsOf(q.change);
    if (
      refused.has(q.cid) ||
      groups.has(groupOf(q)) ||
      names(q.change, added) ||
      targets.some((t) => touched.has(t))
    ) {
      held.add(q.cid);
      groups.add(groupOf(q));
      addedBy(q.change).forEach((id) => added.add(id));
      targets.forEach((t) => touched.add(t));
    }
  }
  return held;
}

/**
 * What's sent for these changes, as changesBody in web/src/offline/outbox.ts makes it: each
 * with its id and the currency it was typed in, null for one kept from before
 */
const changesBody = (batch) => ({
  changes: batch.map((q) => q.change),
  ids: batch.map((q) => q.cid),
  currencies: batch.map((q) => (q.currency == null ? null : q.currency)),
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
        Promise.all(
          keys
            .filter((k) => !KEEP.includes(k) && !k.startsWith(IMAGE_CACHE_PREFIX))
            .map((k) => caches.delete(k)),
        ),
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

/** The profile picture, as the app asks for it (with ?v=) */
const isPicture = (url) => url.pathname === PICTURE_PATH && url.searchParams.has('v');

/** Who the app last said is signed in (USER_KEY), or null */
async function signedInAccount() {
  const db = await openDb();
  try {
    const user = await idb(db, 'readonly', (s) => s.get(USER_KEY));
    return typeof user === 'string' ? user : null;
  } finally {
    db.close();
  }
}

/** This account's copy of the picture, if it was shown one */
async function keptPicture(request) {
  const account = await signedInAccount().catch(() => null);
  const name = account == null ? null : `${IMAGE_CACHE_PREFIX}${account}`;
  if (name == null || !(await caches.has(name))) return undefined;
  return (await caches.open(name)).match(new URL(request.url).pathname);
}

/**
 * Forgets the signed-in account's copy of a picture the server no longer shows it (the
 * 404 names no account: it's for whoever is signed in). Other accounts' copies stay.
 */
async function forgetPicture(request) {
  const account = await signedInAccount().catch(() => null);
  if (account == null) return;
  const name = `${IMAGE_CACHE_PREFIX}${account}`;
  if (!(await caches.has(name))) return;
  await (await caches.open(name)).delete(new URL(request.url).pathname);
}

/**
 * The picture from the server, so a change, or another account signed in, is checked
 * each time; the kept copy only when the server can't be reached or is failing, and only
 * the signed-in account's. A sign-in page in its place shows nothing. One copy is kept per
 * account, whatever its version, so the newest shown is the one shown offline.
 */
async function picture(event) {
  const { request } = event;
  let response;
  try {
    // Checked with the server even when the browser holds a copy
    response = await fetch(request, { cache: 'no-cache' });
  } catch (err) {
    const kept = await keptPicture(request);
    if (kept) return kept;
    throw err;
  }
  if (response.status >= 500) return (await keptPicture(request)) ?? response;
  const viewer = response.headers.get(IMAGE_VIEWER_HEADER);
  if (
    response.ok &&
    response.type === 'basic' &&
    !response.redirected &&
    viewer != null &&
    (response.headers.get('Content-Type') ?? '').startsWith('image/')
  ) {
    const copy = response.clone();
    const path = new URL(request.url).pathname;
    event.waitUntil(caches.open(`${IMAGE_CACHE_PREFIX}${viewer}`).then((c) => c.put(path, copy)));
  } else if (response.status === 404) {
    // Gone back to the initial
    event.waitUntil(forgetPicture(request));
  }
  return response;
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
  } else if (isPicture(url)) {
    event.respondWith(picture(event));
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
 * Reads `account`'s outbox and writes back what `edit` makes of it, in one transaction, as
 * the app does (editOutbox in web/src/offline/outbox.ts): a change the app keeps meanwhile
 * is never written over
 */
function editOutbox(db, account, key, edit) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keyval', 'readwrite');
    const store = tx.objectStore('keyval');
    const read = store.get(key);
    read.onsuccess = () => {
      const entry = read.result;
      if (entry?.email !== account || !Array.isArray(entry.value)) return;
      const after = edit(entry.value);
      if (after.length > 0) store.put({ ...entry, value: after }, key);
      else store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/**
 * Sends changes `account` kept; the server refuses them if someone else is signed in
 * now. Resolves with whether they were saved, and if not why the server refused them;
 * throws TryLater to keep them for next time.
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
  if ([401, 408, 413, 425, 429].includes(res.status) || res.status >= 500) {
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
  if (res.ok) return { saved: true };
  // Refused only by the app's own server, which says why in JSON; anything else in
  // between (Cloudflare Access, a proxy, a deploy) is tried again, as the app does
  if (typeof answer?.error !== 'string') throw new TryLater(`HTTP ${res.status}, not the API`);
  // With the server's reason, as refusalReason in web/src/offline/outbox.ts
  return { saved: false, reason: answer.error || REFUSED_REASON };
}

/**
 * Sends the signed-in account's changes, in order; nobody else's. One the server refuses
 * is found by halving the requests, as the app does, then kept with why and with what's
 * held with it; the rest still go.
 */
async function sendOutbox() {
  const db = await openDb();
  try {
    const user = await idb(db, 'readonly', (s) => s.get(USER_KEY));
    if (typeof user !== 'string') return;
    const key = `${OUTBOX_PREFIX}${user}`;
    await withLock(user, async () => {
      let maxGroups = Infinity;
      for (;;) {
        // Read each time, under the lock: the app may have sent some meanwhile, or kept
        // new ones (which never waits for this lock)
        const entry = await idb(db, 'readonly', (s) => s.get(key));
        if (entry?.email !== user || !Array.isArray(entry.value)) return;
        const waiting = entry.value.filter((q) => isQueued(q) && q.refused == null);
        if (waiting.length === 0) return;
        // As many at a time as the server takes. Each request's changes are crossed off
        // once saved, so a failure later on leaves only what wasn't sent.
        const batch = nextBatch(waiting, maxGroups);
        const sent = new Set(batch.map((q) => q.cid));
        const answer = await post('/api/changes', changesBody(batch), entry.email);
        if (answer.saved) {
          await editOutbox(db, user, key, (kept) => kept.filter((q) => !sent.has(q.cid)));
        } else if (groupsIn(batch) > 1) {
          maxGroups = Math.ceil(groupsIn(batch) / 2);
        } else {
          maxGroups = Infinity;
          const refused = { reason: answer.reason, set: batch[0].cid };
          await editOutbox(db, user, key, (kept) => {
            const held = heldWith(kept, sent);
            return kept.map((q) => (held.has(q.cid) ? { ...q, refused } : q));
          });
        }
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

// --- Reminders: shown as they come, opened where they point ---------------------------

/** What's shown when a push can't be read: something must be, the browser insists */
const FALLBACK_REMINDER = {
  title: 'Mahnee',
  body: 'Open Mahnee to see your reminder.',
  url: '/',
  tag: 'reminder',
};

/** One of the app's own pages ("/?plan=scheduled"), or Home for anything else */
const ownPage = (url) =>
  typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';

/**
 * accountTag in worker/push/reminder-text.ts: which account a reminder is for, without
 * naming it (the first 16 hex characters of the SHA-256 of "mahnee-push:" and the email in
 * small letters)
 */
async function accountTag(email) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8.encode(`mahnee-push:${email.toLowerCase()}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Who the app last said is signed in here, or null */
async function signedInHere() {
  const db = await openDb();
  try {
    const user = await idb(db, 'readonly', (s) => s.get(USER_KEY));
    return typeof user === 'string' ? user : null;
  } finally {
    db.close();
  }
}

/**
 * The message the server sent (worker/push/send.ts ReminderMessage); the fallback, saying
 * nothing of it, for one that can't be read or is meant for another account than the one
 * signed in here (or with no one signed in). Something is always shown, or the browser
 * stops the subscription.
 */
async function readReminder(data) {
  let message = null;
  try {
    message = data?.json();
  } catch {
    message = null;
  }
  if (typeof message?.title !== 'string' || message.title === '') return FALLBACK_REMINDER;
  const user = await signedInHere().catch(() => null);
  if (user == null || message.account !== (await accountTag(user))) return FALLBACK_REMINDER;
  return {
    title: message.title,
    body: typeof message.body === 'string' ? message.body : '',
    url: ownPage(message.url),
    tag: typeof message.tag === 'string' ? message.tag : FALLBACK_REMINDER.tag,
  };
}

/** Shows a reminder that came: as sent if it's for the account signed in here */
async function showReminder(data) {
  const { title, body, url, tag } = await readReminder(data);
  await self.registration.showNotification(title, {
    body,
    tag,
    icon: '/icon-192.png',
    // Android's small icon in the status bar: the mark alone, as only its shape shows
    badge: '/badge-96.png',
    data: { url },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showReminder(event.data));
});

/**
 * Brings a window of the app already open (the one in front, if any) to the page, or
 * opens one when there's none or it can't be brought there
 */
async function openAt(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const ours = windows.filter((w) => new URL(w.url).origin === self.location.origin);
  const open = ours.find((w) => w.focused) ?? ours[0];
  if (open != null) {
    try {
      const shown = (await open.navigate(url)) ?? open;
      return await shown.focus();
    } catch {
      // Not one this service worker controls: a new window instead
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(ownPage(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(openAt(url));
});
