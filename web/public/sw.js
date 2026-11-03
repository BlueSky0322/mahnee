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
