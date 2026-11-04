// What the API sends back, in one place: the Worker builds these and the app reads
// them, so a field changed on one side fails to compile on the other.

import type { RateSource } from './rates';

// ---------- Account ----------

export const THEMES = ['dark', 'light', 'auto'] as const;
export const ACCENTS = ['blurple', 'blue', 'teal', 'green', 'amber', 'rose'] as const;
/** Where an account's exchange rates come from first (see RATE_PROVIDERS) */
export const RATE_PREFERENCES = ['wise', 'ecb'] as const;

export type ThemeSetting = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type RatePreference = (typeof RATE_PREFERENCES)[number];

/** The longest display name an account can have */
export const MAX_DISPLAY_NAME = 32;

/** Private preferences that follow the account between devices */
export interface Settings {
  theme: ThemeSetting;
  accent: Accent;
  ratePreference: RatePreference;
}

/** Settings before anyone changes them */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  accent: 'blurple',
  ratePreference: 'wise',
};

/** The signed-in account and its private settings */
export interface Profile {
  email: string;
  displayName: string | null;
  settings: Settings;
}

export interface ProfilePatch {
  displayName?: string | null;
  settings?: Partial<Settings>;
}

// ---------- Rates ----------

/** A fetched rate (never a typed one) */
export type FetchedRateSource = Exclude<RateSource, 'manual'>;

/** The service each rate preference stands for: the ECB's rates come from Frankfurter */
export const RATE_PROVIDERS: Record<RatePreference, FetchedRateSource> = {
  wise: 'wise',
  ecb: 'frankfurter',
};

/** GET /api/rates: one currency into another */
export interface RateQuote {
  from: string;
  to: string;
  rate: number;
  source: FetchedRateSource;
  /** When it was fetched; for an earlier day's rate (?at=), noon UTC on that day */
  fetchedAt: number;
  /** The amount asked about (?amount=), converted */
  convertedCents?: number;
}

// ---------- Requests ----------

/** The header a request names its tab in */
export const CLIENT_ID_HEADER = 'X-Client-Id';

/**
 * Whose a write is: the account it was made as, which the server checks against the one
 * signed in now before changing anything. Never chooses who's signed in.
 */
export const EXPECTED_ACCOUNT_HEADER = 'X-Expected-Account';

/** A row the app makes before it's saved: 16 hex characters */
export const ROW_ID_CHARS = '[0-9a-f]{16}';
const ROW_ID_PATTERN = new RegExp(`^${ROW_ID_CHARS}$`);
export const isRowId = (v: unknown): v is string => typeof v === 'string' && ROW_ID_PATTERN.test(v);

// ---------- Writes ----------

/** What a change that returns nothing else sends back */
export interface Ok {
  ok: true;
}

/** What every refused or failed request sends back */
export interface ApiErrorBody {
  error: string;
  /** What went wrong, for the app to act on, where the status alone doesn't say */
  code?: ErrorCode;
}

/**
 * account_mismatch: the write was made for another account than the one signed in now,
 * so it's kept (not sent again) until that account is back. client_update_required: an
 * app too old to say whose a write is; kept until it updates.
 */
export type ErrorCode = 'account_mismatch' | 'client_update_required';
