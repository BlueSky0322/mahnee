// Starts the real Worker with `wrangler dev` against a fresh, empty local D1, for tests
// that go through the API the way the app does. Access is switched off and requests say
// who they are with the X-Dev-User header (see accounts/auth.ts).
//
// Every step has a time limit, and whatever has been started so far is stopped again if
// a later step fails. Each run has its own ports, database folder and stand-in rate
// services, so several runs can go at once.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newVapidKeys } from './push-receiver';

const ROOT = resolve(__dirname, '../..');
const MIGRATE_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
/** How long one "are you up yet" request may take before it's given up and tried again */
const PROBE_TIMEOUT_MS = 5_000;
/** How long wrangler and workerd get to exit after being asked, before they're killed */
const EXIT_TIMEOUT_MS = 10_000;
/** How many times the Worker is started on fresh ports when one it was given is taken */
const BIND_ATTEMPTS = 3;
/** Where the stand-in rate services also serve Google pictures */
const GOOGLE_PREFIX = '/google/';
/** The pair the readiness check asks for, which only this run's fake services hear about */
const PROBE_PAIR = ['PRB', 'PRC'] as const;

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether any process in the group led by `pid` is still running */
function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    // EPERM: something is there, it just isn't ours to signal
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone
  }
}

/**
 * Stops a process started with `detached` and everything it started (wrangler starts
 * workerd), waiting until they have all exited: politely first, then by force.
 */
async function stopGroup(child: ChildProcess) {
  const pid = child.pid;
  if (pid == null) return;
  const waitGone = async (ms: number) => {
    const until = Date.now() + ms;
    while (groupAlive(pid) && Date.now() < until) await sleep(50);
    return !groupAlive(pid);
  };
  signalGroup(pid, 'SIGTERM');
  if (await waitGone(EXIT_TIMEOUT_MS)) return;
  signalGroup(pid, 'SIGKILL');
  if (!(await waitGone(EXIT_TIMEOUT_MS))) {
    throw new Error(`wrangler (process group ${pid}) didn't exit`);
  }
}

/** Starts a command in its own process group, collecting everything it prints */
function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn('npx', args, { cwd: ROOT, env, stdio: 'pipe', detached: true });
  const output = { text: '' };
  child.stdout?.on('data', (d) => (output.text += d));
  child.stderr?.on('data', (d) => (output.text += d));
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => done(code));
    child.once('error', () => done(null));
  });
  return { child, output, exited };
}

export interface LocalWorker {
  /** Calls the API as `who`, returning the status and parsed body */
  call: <T = any>(
    who: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; data: T }>;
  /** The same call, answering with the response as it came, for its headers or bytes */
  raw: (
    who: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  /** The stand-in for Wise and Frankfurter that the Worker gets its rates from */
  rates: FakeRates;
  /** The stand-in push service the Worker sends reminders to */
  push: FakePush;
  /** The VAPID public key the Worker signs its pushes with */
  vapidPublicKey: string;
  /** The stand-in for Google's picture host, which a Google picture is copied from */
  google: FakeGoogle;
  /** Where it's listening, e.g. http://127.0.0.1:1234 */
  base: string;
  /**
   * Runs one statement on the Worker's database itself, for a state the API can't make
   * on cue (two rows changed in the same millisecond); answers its rows
   */
  sql: (statement: string, ...params: (string | number | null)[]) => Promise<unknown[]>;
  /** Stops the Worker and the fake services, then deletes the database */
  stop: () => Promise<void>;
}

type Service = 'wise' | 'frankfurter';

/** One request the push service was handed */
export interface PushRequest {
  path: string;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export interface FakePush {
  /** Where it's listening; a subscription's endpoint is `${base}/push/<anything>` */
  base: string;
  /** Every request handed to it, in order */
  received: () => PushRequest[];
  /**
   * Answers requests for `path` with `status` from now on (201 unless said); a redirect
   * (3xx) points at `${base}/push/redirected`
   */
  answer: (path: string, status: number) => void;
  /** Answers the next requests for `path` with these, one each, before the lasting answer */
  answerNext: (path: string, ...statuses: number[]) => void;
  /** Forgets what it was handed and how it answers */
  reset: () => void;
}

/** A push service: takes every message with 201, or as told, and keeps what it was handed */
async function startFakePush(): Promise<FakePush & { close: () => void }> {
  let received: PushRequest[] = [];
  const answers = new Map<string, number>();
  const queued = new Map<string, number[]>();
  let base = '';
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = [v].flat().join(', ');
      received.push({ path, headers, body: new Uint8Array(Buffer.concat(chunks)) });
      const status = queued.get(path)?.shift() ?? answers.get(path) ?? 201;
      res.writeHead(
        status,
        status >= 300 && status < 400 ? { Location: `${base}/push/redirected` } : {},
      );
      res.end();
    });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
  return {
    base,
    received: () => [...received],
    answer: (path, status) => void answers.set(path, status),
    answerNext: (path, ...statuses) => void queued.set(path, statuses),
    reset: () => {
      received = [];
      answers.clear();
      queued.clear();
    },
    close: () => server.close(),
  };
}

export interface FakeGoogle {
  /** Where pictures are served from, as GOOGLE_PICTURE_BASE: `${base}a/<name>` */
  base: string;
  /** Serves `bytes` as `contentType` at `path` (under base) */
  set: (path: string, bytes: Uint8Array, contentType: string) => void;
  /** How many times `path` (under base) was asked for */
  asked: (path: string) => number;
  /** Holds back the answer for `path` until released, as a slow host does */
  hold: (path: string) => { release: () => void };
}

export interface FakeRates {
  /**
   * 1 `from` is `rate` `to`, on both services or only the one named. The Worker keeps
   * every rate it fetches for hours, across tests, so a pair is refused a rate other
   * than one it was given earlier in the run: use newCurrency() for a pair of your own.
   */
  set: (from: string, to: string, rate: number, service?: Service) => void;
  /**
   * The same, for an earlier day (2026-10-12): Frankfurter's rate for that date, and
   * Wise's when asked for a time on it. Wise asked about a day it has no rate for answers
   * with today's, as a service ignoring the time would.
   */
  setOn: (day: string, from: string, to: string, rate: number, service?: Service) => void;
  /** Makes one service answer 500 */
  down: (service: Service, isDown: boolean) => void;
  /** Makes the ECB answer 500 to any range that holds one of these days (none to stop) */
  downOn: (days: string[]) => void;
  /** Forgets every rate and brings both services back, so tests don't lean on each other */
  reset: () => void;
  /**
   * A made-up currency code no other test has, so the rates the Worker keeps from other
   * tests can't get in the way
   */
  newCurrency: () => string;
  /** How many times either service has been asked for this pair, answered or not */
  asked: (from: string, to: string) => number;
  /**
   * Holds back every answer for this pair until released: `reached` settles once the
   * first request for it has come, so a test can change something while a write waits
   */
  hold: (from: string, to: string) => { reached: Promise<void>; release: () => void };
}

/**
 * A tiny HTTP server answering like Wise's /v1/rates (with a time or without) and
 * Frankfurter's /v1/latest and /v1/<date>, and serving Google pictures under /google/
 */
async function startFakeRates(): Promise<
  FakeRates & {
    base: string;
    close: () => void;
    heardProbe: () => boolean;
    google: FakeGoogle;
  }
> {
  const table = new Map<string, number>();
  /** Days a range answers 500 for, as a service failing for part of a long range */
  let downDays: string[] = [];
  /** The days a service has a rate for the pair on, in order */
  const setDays = (service: Service, from: string | null, to: string | null) =>
    [...table.keys()]
      .map((k) => k.split(':'))
      .filter(([s, d, pair]) => s === service && pair === `${from}${to}` && d !== '')
      .map(([, d]) => d)
      .sort();
  // Every rate a pair was given this run, to catch a test that would get a kept one
  const given = new Map<string, number>();
  const isDown = { wise: false, frankfurter: false };
  let probed = false;
  let codes = 0;
  const askedFor = new Map<string, number>();
  const holds = new Map<string, { arrived: () => void; released: Promise<void> }>();
  const googlePictures = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const googleAsked = new Map<string, number>();
  const googleHeld = new Map<string, Promise<void>>();
  const answer = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const heard = (from: string | null, to: string | null) => {
      if (from === PROBE_PAIR[0] && to === PROBE_PAIR[1]) probed = true;
      askedFor.set(`${from}${to}`, (askedFor.get(`${from}${to}`) ?? 0) + 1);
    };
    if (url.pathname.startsWith(GOOGLE_PREFIX)) {
      const path = url.pathname.slice(GOOGLE_PREFIX.length);
      googleAsked.set(path, (googleAsked.get(path) ?? 0) + 1);
      const serve = () => {
        const picture = googlePictures.get(path);
        if (picture == null) return send(404, {});
        res.writeHead(200, { 'Content-Type': picture.contentType });
        res.end(picture.bytes);
      };
      const held = googleHeld.get(path);
      if (held == null) return serve();
      return void held.then(serve);
    }
    if (url.pathname === '/v1/rates') {
      const [from, to] = [url.searchParams.get('source'), url.searchParams.get('target')];
      heard(from, to);
      if (isDown.wise || req.headers.authorization !== 'Bearer test-token') return send(500, {});
      // A range, as the real one answers it: a point every hour for up to 720 hours, and past
      // that one point a day, at midnight, with no word that it changed; only the days given
      // a rate have points
      const [start, end] = [url.searchParams.get('from'), url.searchParams.get('to')];
      if (start != null && end != null) {
        const hours = (Date.parse(`${end}:00Z`) - Date.parse(`${start}:00Z`)) / 3_600_000 + 1;
        const days = setDays('wise', from, to).filter(
          (d) => d >= start.slice(0, 10) && d <= end.slice(0, 10),
        );
        const point = (d: string, hour: number) => ({
          rate: table.get(`wise:${d}:${from}${to}`),
          source: from,
          target: to,
          time: `${d}T${String(hour).padStart(2, '0')}:00:00+0000`,
        });
        return send(
          200,
          hours > 720
            ? days.map((d) => point(d, 0))
            : days.flatMap((d) => Array.from({ length: 24 }, (_, h) => point(d, h))),
        );
      }
      const day = url.searchParams.get('time')?.slice(0, 10);
      const onDay = day == null ? null : table.get(`wise:${day}:${from}${to}`);
      if (onDay != null) {
        // The latest point at or before the time asked, as the real one: a little before noon
        return send(200, [{ rate: onDay, source: from, target: to, time: `${day}T11:59:14+0000` }]);
      }
      const rate = table.get(`wise:${from}${to}`);
      const now = new Date().toISOString().slice(0, 19);
      return rate == null
        ? send(400, {})
        : send(200, [{ rate, source: from, target: to, time: `${now}+0000` }]);
    }
    // A range of days: each working day it has from the first to the last, and the one on
    // or before the first, as the real one starts there
    const range = /^\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
    if (range) {
      const [from, to] = [url.searchParams.get('base'), url.searchParams.get('symbols')];
      heard(from, to);
      if (isDown.frankfurter || downDays.some((d) => d >= range[1] && d <= range[2])) {
        return send(500, {});
      }
      const all = setDays('frankfurter', from, to);
      const before = all.filter((d) => d < range[1]).at(-1);
      const days = [
        ...(before == null ? [] : [before]),
        ...all.filter((d) => d >= range[1] && d <= range[2]),
      ];
      if (days.length === 0 && table.get(`frankfurter:${from}${to}`) == null) return send(404, {});
      return send(200, {
        base: from,
        rates: Object.fromEntries(
          days.map((d) => [d, { [to!]: table.get(`frankfurter:${d}:${from}${to}`) }]),
        ),
      });
    }
    const dated = /^\/v1\/(latest|\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
    if (dated) {
      const [from, to] = [url.searchParams.get('base'), url.searchParams.get('symbols')];
      heard(from, to);
      const day = dated[1] === 'latest' ? null : dated[1];
      const rate = table.get(
        day == null ? `frankfurter:${from}${to}` : `frankfurter:${day}:${from}${to}`,
      );
      if (isDown.frankfurter) return send(500, {});
      return rate == null
        ? send(404, {})
        : send(200, {
            base: from,
            date: day ?? new Date().toISOString().slice(0, 10),
            rates: { [to!]: rate },
          });
    }
    send(404, {});
  };
  const server = createHttpServer((req, res) => {
    // A held pair waits for its release
    const url = new URL(req.url ?? '/', 'http://x');
    const pair = `${url.searchParams.get('source') ?? url.searchParams.get('base')}${
      url.searchParams.get('target') ?? url.searchParams.get('symbols')
    }`;
    const held = holds.get(pair);
    if (held == null) return answer(req, res);
    held.arrived();
    void held.released.then(() => answer(req, res));
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  /** Gives a pair a rate, today's or (with `day` as "2026-10-12:") that day's */
  const give = (day: string, from: string, to: string, rate: number, service?: Service) => {
    for (const s of service == null ? (['wise', 'frankfurter'] as const) : [service]) {
      const key = `${s}:${day}${from}${to}`;
      const before = given.get(key);
      if (before != null && before !== rate) {
        throw new Error(
          `${from} to ${to} on ${s} was already ${before} this run, and the Worker may ` +
            'still have that rate: use rates.newCurrency() for a pair of your own',
        );
      }
      given.set(key, rate);
      table.set(key, rate);
    }
  };
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    set: (from, to, rate, service) => give('', from, to, rate, service),
    setOn: (day, from, to, rate, service) => give(`${day}:`, from, to, rate, service),
    down: (service, value) => {
      isDown[service] = value;
    },
    downOn: (days) => {
      downDays = days;
    },
    reset: () => {
      table.clear();
      downDays = [];
      isDown.wise = false;
      isDown.frankfurter = false;
    },
    newCurrency: () => {
      // QBA, QBB, ...: Q codes aren't real currencies, bar QAR, which is never reached
      const n = 26 + codes++;
      if (n >= 26 * 26) throw new Error('Out of made-up currency codes');
      const letter = (i: number) => String.fromCharCode(65 + i);
      return `Q${letter(Math.floor(n / 26))}${letter(n % 26)}`;
    },
    asked: (from, to) => askedFor.get(`${from}${to}`) ?? 0,
    hold: (from, to) => {
      let arrived = () => {};
      let release = () => {};
      const reached = new Promise<void>((r) => (arrived = r));
      const released = new Promise<void>((r) => (release = r));
      holds.set(`${from}${to}`, { arrived, released });
      return {
        reached,
        release: () => {
          holds.delete(`${from}${to}`);
          release();
        },
      };
    },
    heardProbe: () => probed,
    google: {
      base: `http://127.0.0.1:${port}${GOOGLE_PREFIX}`,
      set: (path, bytes, contentType) => googlePictures.set(path, { bytes, contentType }),
      asked: (path) => googleAsked.get(path) ?? 0,
      hold: (path) => {
        let release = () => {};
        googleHeld.set(path, new Promise<void>((r) => (release = r)));
        return {
          release: () => {
            googleHeld.delete(path);
            release();
          },
        };
      },
    },
    close: () => server.close(),
  };
}

export async function startLocalWorker({ mcpWrites = false } = {}): Promise<LocalWorker> {
  // Undone in reverse order, so the Worker has exited before its database is deleted
  const cleanups: (() => unknown)[] = [];
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      const failures: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw failures[0];
    })());

  try {
    const persist = mkdtempSync(join(tmpdir(), 'mahnee-test-'));
    cleanups.push(() => rmSync(persist, { recursive: true, force: true }));
    // wrangler dev wants the assets folder to exist, even if the app isn't built
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
    const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };

    const migrate = start(
      ['wrangler', 'd1', 'migrations', 'apply', 'mahnee-db', '--local', '--persist-to', persist],
      env,
    );
    cleanups.push(() => stopGroup(migrate.child));
    // The deadline is cleared once migrations finish, so it doesn't keep the run going
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const migrated = await Promise.race([
      migrate.exited,
      new Promise<'late'>((r) => (deadline = setTimeout(() => r('late'), MIGRATE_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(deadline));
    if (migrated !== 0) {
      throw new Error(
        migrated === 'late'
          ? `Migrations took over ${MIGRATE_TIMEOUT_MS / 1000}s:\n${migrate.output.text}`
          : `Migrations failed:\n${migrate.output.text}`,
      );
    }

    const rates = await startFakeRates();
    cleanups.push(() => rates.close());
    const push = await startFakePush();
    cleanups.push(() => push.close());
    const vapid = await newVapidKeys();
    // A port picked free a moment ago can be taken by the time workerd binds it: the
    // other Worker-backed test file starts at the same moment. Then once more, on others.
    let port = 0;
    let inspectorPort = 0;
    const launch = () =>
      start(
        [
          'wrangler',
          'dev',
          '--ip',
          '127.0.0.1',
          '--port',
          String(port),
          '--inspector-port',
          String(inspectorPort),
          '--persist-to',
          persist,
          '--var',
          'ACCESS_TEAM_DOMAIN:',
          '--var',
          'ACCESS_AUD:',
          '--var',
          'ACCESS_MCP_AUD:',
          '--var',
          'ACCESS_MCP_WRITE_AUD:',
          '--var',
          `DEV_MCP_WRITES:${mcpWrites}`,
          '--var',
          'DEV_USER_EMAIL:nobody@example.com',
          '--var',
          `WISE_BASE:${rates.base}`,
          '--var',
          `FRANKFURTER_BASE:${rates.base}`,
          '--var',
          'WISE_TOKEN:test-token',
          '--var',
          `VAPID_PUBLIC_KEY:${vapid.publicKey}`,
          '--var',
          `VAPID_PRIVATE_KEY:${vapid.privateJwk}`,
          '--var',
          `PUSH_TEST_ORIGIN:${push.base}`,
          // A conversion step that failed is tried again after a second, not minutes
          '--var',
          'CONVERT_RETRY_DELAY_S:1',
          // The stand-in services gain rates as tests go, so no range of them is kept
          '--var',
          'RATES_KEEP_RANGES:no',
          '--var',
          `GOOGLE_PICTURE_BASE:${rates.google.base}`,
          '--log-level',
          'warn',
        ],
        env,
      );
    let base = '';
    for (let attempt = 1; ; attempt++) {
      [port, inspectorPort] = [await freePort(), await freePort()];
      const worker = launch();
      cleanups.push(() => stopGroup(worker.child));
      let exitCode: number | null | undefined;
      void worker.exited.then((code) => (exitCode = code));

      // Ready once it answers a request that reaches this run's fake rate services, so a
      // Worker from another run that got the same port is never mistaken for this one
      base = `http://127.0.0.1:${port}`;
      const started = Date.now();
      let answered = false;
      let ready = false;
      while (!ready) {
        try {
          const res = await fetch(`${base}/api/rates?from=${PROBE_PAIR[0]}&to=${PROBE_PAIR[1]}`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          await res.arrayBuffer();
          answered = true;
        } catch {
          // Not listening yet, or too slow to answer: asked again
        }
        if (rates.heardProbe()) ready = true;
        else if (exitCode !== undefined || Date.now() - started > READY_TIMEOUT_MS) {
          const taken =
            exitCode !== undefined && worker.output.text.includes('Address already in use');
          if (taken && attempt < BIND_ATTEMPTS) break;
          const why = answered ? 'its port answers, but not from this run' : "it didn't start";
          throw new Error(`wrangler dev on port ${port}: ${why}\n${worker.output.text}`);
        } else await sleep(250);
      }
      if (ready) break;
    }

    const raw: LocalWorker['raw'] = (who, method, path, body, headers = {}) =>
      fetch(base + path, {
        method,
        headers: {
          'X-Dev-User': who,
          'X-Expected-Account': who,
          'Content-Type': 'application/json',
          ...headers,
        },
        // Bytes and strings go as they are; anything else as JSON
        body:
          body === undefined || typeof body === 'string' || body instanceof Uint8Array
            ? (body as BodyInit | undefined)
            : JSON.stringify(body),
      });

    // The database wrangler keeps for the Worker; it sees writes made here straight away
    const sql: LocalWorker['sql'] = async (statement, ...params) => {
      const { DatabaseSync } = await import('node:sqlite');
      const dir = join(persist, 'v3', 'd1', 'miniflare-D1DatabaseObject');
      const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
      const db = new DatabaseSync(join(dir, file!));
      try {
        return db.prepare(statement).all(...params);
      } finally {
        db.close();
      }
    };

    return {
      stop,
      rates,
      push,
      vapidPublicKey: vapid.publicKey,
      google: rates.google,
      base,
      raw,
      sql,
      call: async (who, method, path, body, headers) => {
        const res = await raw(who, method, path, body, headers);
        const text = await res.text();
        let data: any = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        return { status: res.status, data };
      },
    };
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
}
