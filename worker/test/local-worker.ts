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

const ROOT = resolve(__dirname, '../..');
const MIGRATE_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
/** How long one "are you up yet" request may take before it's given up and tried again */
const PROBE_TIMEOUT_MS = 5_000;
/** How long wrangler and workerd get to exit after being asked, before they're killed */
const EXIT_TIMEOUT_MS = 10_000;
/** How many times the Worker is started on fresh ports when one it was given is taken */
const BIND_ATTEMPTS = 3;
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
 * Frankfurter's /v1/latest and /v1/<date>
 */
async function startFakeRates(): Promise<
  FakeRates & { base: string; close: () => void; heardProbe: () => boolean }
> {
  const table = new Map<string, number>();
  // Every rate a pair was given this run, to catch a test that would get a kept one
  const given = new Map<string, number>();
  const isDown = { wise: false, frankfurter: false };
  let probed = false;
  let codes = 0;
  const askedFor = new Map<string, number>();
  const holds = new Map<string, { arrived: () => void; released: Promise<void> }>();
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
    if (url.pathname === '/v1/rates') {
      const [from, to] = [url.searchParams.get('source'), url.searchParams.get('target')];
      heard(from, to);
      if (isDown.wise || req.headers.authorization !== 'Bearer test-token') return send(500, {});
      const day = url.searchParams.get('time')?.slice(0, 10);
      const onDay = day == null ? null : table.get(`wise:${day}:${from}${to}`);
      if (onDay != null) {
        return send(200, [{ rate: onDay, source: from, target: to, time: `${day}T12:00:00+0000` }]);
      }
      const rate = table.get(`wise:${from}${to}`);
      const now = new Date().toISOString().slice(0, 19);
      return rate == null
        ? send(400, {})
        : send(200, [{ rate, source: from, target: to, time: `${now}+0000` }]);
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
    reset: () => {
      table.clear();
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
    close: () => server.close(),
  };
}

export async function startLocalWorker(): Promise<LocalWorker> {
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
          'DEV_USER_EMAIL:nobody@example.com',
          '--var',
          `WISE_BASE:${rates.base}`,
          '--var',
          `FRANKFURTER_BASE:${rates.base}`,
          '--var',
          'WISE_TOKEN:test-token',
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
        headers: { 'X-Dev-User': who, 'Content-Type': 'application/json', ...headers },
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
