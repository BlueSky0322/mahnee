// What the freshness label says: whether the figures shown are the server's and nothing is
// waiting ("Up to date"), come from the copy kept on this device ("From this device, 3 h
// old"), changes wait to be saved ("Offline · 2 changes waiting to save"), or amounts are
// being converted into a new home currency ("Converting to USD…")

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
}

/**
 * The label's words, and whether it's the fresh kind (the green dot). Changes waiting
 * offline come first, so they're never out of sight; nothing is said to be saving while
 * the figures are still the device's, since the server isn't answering then.
 */
export function freshnessText({
  online,
  waiting,
  signedOut,
  convertingTo = null,
  convertedPercent = null,
  at,
  now,
}: FreshnessState) {
  const fromDevice =
    at == null
      ? null
      : at === 0
        ? 'From this device'
        : `From this device, ${ageInWords(now - at)} old`;
  let text: string;
  if (!online && waiting > 0) text = `Offline · ${changes(waiting)} waiting to save`;
  else if (!online) text = fromDevice ?? 'Offline';
  else if (signedOut && waiting > 0) text = `Signed out · ${changes(waiting)} waiting to save`;
  // Changes wait until it's done, so this is what's going on
  else if (convertingTo != null) text = convertingText(convertingTo, convertedPercent);
  else if (fromDevice != null) text = fromDevice;
  else if (waiting > 0) text = `Saving ${changes(waiting)}`;
  else return { text: 'Up to date', fresh: true };
  return { text, fresh: false };
}
