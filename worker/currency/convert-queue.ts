// Running conversions (convert.ts) from the mahnee-reconvert queue (wrangler.jsonc): each
// message takes one conversion one step on, then queues the next. A step that fails (both
// rate services down) is tried again, each time waiting longer; after max_retries it goes to
// mahnee-reconvert-dlq, and the person reading their profile starts it again
// (restartStalled). Only an error's name and message are logged, never a job: it names the
// person.

import type { Env } from '../app';
import { getRatePreference } from '../accounts/profiles';
import { type ConvertJob, STALLED_MS, convertStep, readConversionRow } from './convert';
import { getRateOn } from './exchange-rates';

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
  const more = await convertStep(env.DB, job, (from, to, day) =>
    getRateOn(env, from, to, Date.parse(`${day}T12:00:00Z`), { prefer }),
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
      msg.retry({ delaySeconds: retryDelay(env, msg.attempts) });
    }
  }
}

/** Given up after max_retries: still converting, and started again when the person reads it */
export function handleConvertDeadLetters(batch: MessageBatch<ConvertJob>) {
  for (const msg of batch.messages) {
    console.error('gave up on a conversion step for now');
    msg.ack();
  }
}

/** The dead-letter queue's name, as in wrangler.jsonc */
export const DEAD_LETTER_QUEUE = 'mahnee-reconvert-dlq';

/** The Worker's queue handler: steps, and the ones given up on */
export const handleConvertQueue = (batch: MessageBatch<ConvertJob>, env: Env) =>
  batch.queue === DEAD_LETTER_QUEUE
    ? handleConvertDeadLetters(batch)
    : handleConvertBatch(batch, env);

/**
 * A conversion that hasn't moved on for STALLED_MS (the queue gave up, or a step was never
 * queued) is started again, once: marked as moved on first, so readers at once don't each
 * queue it
 */
export async function restartStalled(env: Env, email: string, now = Date.now()) {
  const row = await readConversionRow(env.DB, email);
  if (row?.phase !== 'converting' || now - row.touchedAt < STALLED_MS) return;
  const { meta } = await env.DB.prepare(
    `UPDATE conversions SET touched_at = ?3
     WHERE email = ?1 AND since = ?2 AND phase = 'converting' AND touched_at = ?4`,
  )
    .bind(email, row.since, now, row.touchedAt)
    .run();
  if (meta.changes > 0) await queueConversion(env, { email, since: row.since });
}
