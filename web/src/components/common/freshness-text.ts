// What the freshness label says: whether the figures shown are the server's and nothing is
// waiting ("Up to date"), a save is taking a moment ("Saving") or just landed ("Saved"),
// the figures come from the copy kept on this device ("From this device, 3 h old"),
// changes wait to be saved ("Offline · 2 changes waiting"), or amounts are being converted
// into a new home currency ("Converting to USD…")

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How old something `ms` old is, in the label's short words: "5 min", "3 h", "2 d" */
export function ageInWords(ms: number) {
  if (ms < MINUTE_MS) return 'less than a minute';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  return `${Math.floor(ms / DAY_MS)} d`;
}

/** "1 change", "2 changes" */
const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/** "Converting to USD… 40%", or without the share while it isn't known */
export const convertingText = (to: string, percent: number | null) =>
  `Converting to ${to}…${percent == null ? '' : ` ${percent}%`}`;

/** How far a conversion has got, as a whole percentage; null when the server doesn't say */
export function convertedPercent(progress?: { done: number; total: number }) {
  if (progress == null || progress.total <= 0) return null;
  return Math.min(99, Math.floor((progress.done * 100) / progress.total));
}

export interface FreshnessState {
  /** The browser has a connection */
  online: boolean;
  /** Changes made but not yet saved */
  waiting: number;
  /** Saving stopped until they sign in again */
  signedOut: boolean;
  /** The currency amounts are being converted into on the server, if they are */
  convertingTo?: string | null;
  /** How far that has got, as a whole percentage, when the server says */
  convertedPercent?: number | null;
  /**
   * When the server last confirmed the figures shown, while they come from this device's
   * copy: 0 when that isn't known; null while they're fresh from the server
   */
  at: number | null;
  now: number;
  /** A save has been on its way long enough to say so (useSaveTiming) */
  savingShown?: boolean;
  /** Changes were sent and taken a moment ago (useSaveTiming) */
  justSaved?: boolean;
}

export interface FreshnessLabel {
  text: string;
  /** The same in a few words, for where there's little room (beside "Mahnee" in the sidebar) */
  short: string;
  /** Green when fresh or just saved, muted while saving, amber when old or waiting */
  tone: 'fresh' | 'quiet' | 'old';
  /** The cloud drawn before it: a tick, an arrow up, or struck through */
  icon: 'check' | 'up' | 'slash';
  /**
   * What screen readers are told, once, as a sentence: only problems (offline, signed out,
   * the device's copy), never saving, and without an age that would count up
   */
  say: string | null;
}

/**
 * The label's words, look and what's announced. Changes waiting offline come first, so
 * they're never out of sight; nothing is said to be saving while the figures are still
 * the device's, since the server isn't answering then.
 */
export function freshnessText({
  online,
  waiting,
  signedOut,
  convertingTo = null,
  convertedPercent = null,
  at,
  now,
  savingShown = false,
  justSaved = false,
}: FreshnessState): FreshnessLabel {
  const fromDevice =
    at == null
      ? null
      : at === 0
        ? 'From this device'
        : `From this device, ${ageInWords(now - at)} old`;
  const problem = (text: string, say: string, short = text): FreshnessLabel => ({
    text,
    short,
    tone: 'old',
    icon: 'slash',
    say,
  });
  if (!online && waiting > 0) {
    return problem(
      `Offline · ${changes(waiting)} waiting`,
      `Offline, ${changes(waiting)} waiting to save.`,
      `${waiting} waiting`,
    );
  }
  if (!online && fromDevice == null) return problem('Offline', 'Offline.');
  if (online && signedOut && waiting > 0) {
    return problem(
      `Signed out · ${changes(waiting)} waiting`,
      `Signed out, ${changes(waiting)} waiting to save.`,
      `${waiting} waiting`,
    );
  }
  // Changes wait until it's done, so this is what's going on, with how many are waiting
  if (online && convertingTo != null) {
    let text = convertingText(convertingTo, convertedPercent);
    if (waiting > 0) text = `${text} · ${changes(waiting)} waiting`;
    // The cloud's arrow says it's under way; the currency and how far, in the sidebar
    const short = `${convertingTo}${convertedPercent == null ? '…' : ` ${convertedPercent}%`}`;
    return { text, short, tone: 'old', icon: 'up', say: null };
  }
  if (fromDevice != null) {
    return problem(
      fromDevice,
      'Showing what this device kept, not yet checked with the server.',
      at === 0 ? 'Device copy' : `${ageInWords(now - at!)} old`,
    );
  }
  if (waiting > 0 && savingShown)
    return { text: 'Saving', short: 'Saving', tone: 'quiet', icon: 'up', say: null };
  if (justSaved) return { text: 'Saved', short: 'Saved', tone: 'fresh', icon: 'check', say: null };
  return { text: 'Up to date', short: 'Up to date', tone: 'fresh', icon: 'check', say: null };
}
