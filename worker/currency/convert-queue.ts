// Running conversions (convert.ts) from the mahnee-reconvert queue (wrangler.jsonc): each
// message takes one conversion one step on, then queues the next. A step that fails (both
// rate services down) is tried again, each time waiting longer, and the conversion notes
// when that try is due. After max_retries the job goes to mahnee-reconvert-dlq, which gives
// the person their currency back (release, refused for `rates`): nothing was converted, and
// they can try again later. One that stops some other way (a step never queued) is started
// again when the person reads their profile, once its next try is well overdue, at most
// MAX_RESTARTS times in a row before it's given back the same way (restartStalled). Only an
// error's name and message are logged, never a job: it names the person.

import type { Env } from '../app';
import { getRatePreference } from '../accounts/profiles';
import { type ConvertJob, convertStep, release, restartIfStalled } from './convert';
import { LookupsSpent, RateLookups, getRateOn } from './exchange-rates';

/** The first retry waits this long, giving the rate services a moment to come back */
const FIRST_RETRY_S = 30;
/** The longest wait between tries; 8 tries fit in the day a message is kept */
const MAX_RETRY_S = 60 * 60;

/** Seconds before try `attempts + 1`; CONVERT_RETRY_DELAY_S (for tests) sets every wait */
export function retryDelay(env: Pick<Env, 'CONVERT_RETRY_DELAY_S'>, attempts: number) {
  const configured = Number.parseInt(env.CONVERT_RETRY_DELAY_S ?? '', 10);
  if (!Number.isNaN(configured)) return configured;
  return Math.min(FIRST_RETRY_S * 2 ** Math.max(0, attempts - 1), MAX_RETRY_S);
}

const named = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error';

/** Queues a conversion's next step; one that can't be queued is started again when read */
export async function queueConversion(env: Env, job: ConvertJob) {
  try {
    await env.CONVERT_QUEUE.send(job);
  } catch (err) {
    console.error(`could not queue a conversion: ${named(err)}`);
  }
}

/** Takes a conversion one step on, at the rates the person prefers, queueing the next */
async function step(env: Env, job: ConvertJob) {
  const prefer = await getRatePreference(env.DB, job.email);
  // Each day asked for once in the step, and no more requests than one run may make
  const lookups = new RateLookups();
  const more = await convertStep(env.DB, job, (from, to, day) =>
    getRateOn(env, from, to, Date.parse(`${day}T12:00:00Z`), { prefer, lookups }).catch(
      (err: unknown) => {
        if (err instanceof LookupsSpent) return null;
        throw err;
      },
    ),
  );
  // Thrown, so the step is tried again: it carries on from where this one got to
  if (more) await env.CONVERT_QUEUE.send(job);
}

export async function handleConvertBatch(batch: MessageBatch<ConvertJob>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await step(env, msg.body);
      msg.ack();
    } catch (err) {
      console.error(`conversion step failed, attempt ${msg.attempts}: ${named(err)}`);
      const delaySeconds = retryDelay(env, msg.attempts);
      msg.retry({ delaySeconds });
      // Not stalled while its next try is still to come
      await postpone(env, msg.body, delaySeconds).catch((e: unknown) =>
        console.error(`could not note a conversion's next try: ${named(e)}`),
      );
    }
  }
}

/** Notes when a conversion's next try is due, so it isn't taken for stalled before then */
const postpone = (env: Env, { email, since }: ConvertJob, delaySeconds: number) =>
  env.DB.prepare(
    `UPDATE conversions SET touched_at = MAX(touched_at, ?3)
     WHERE email = ?1 AND since = ?2 AND phase = 'converting'`,
  )
    .bind(email, since, Date.now() + delaySeconds * 1000)
    .run();

/**
 * Given up after max_retries: the person gets their currency back, nothing converted, and
 * can try again later. One that fails to is tried again by the queue.
 */
export async function handleConvertDeadLetters(batch: MessageBatch<ConvertJob>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await release(env.DB, msg.body, 'rates');
      msg.ack();
    } catch (err) {
      console.error(`could not give back a currency: ${named(err)}`);
      msg.retry();
    }
  }
}

/** The dead-letter queue's name, as in wrangler.jsonc */
export const DEAD_LETTER_QUEUE = 'mahnee-reconvert-dlq';

/** The Worker's queue handler: steps, and the ones given up on */
export const handleConvertQueue = (batch: MessageBatch<ConvertJob>, env: Env) =>
  batch.queue === DEAD_LETTER_QUEUE
    ? handleConvertDeadLetters(batch, env)
    : handleConvertBatch(batch, env);

/**
 * Starts a stalled conversion again when the person reads their profile (restartIfStalled in
 * convert.ts), queueing its next step
 */
export const restartStalled = (env: Env, email: string, now = Date.now()) =>
  restartIfStalled(env.DB, email, (job) => queueConversion(env, job), now);
