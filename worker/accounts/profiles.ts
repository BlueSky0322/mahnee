// The account's profile (its display name) and settings (private preferences that
// follow it between devices). A profile row is made the first time someone saves
// anything; until then everything has its default.

import {
  ACCENTS,
  DEFAULT_SETTINGS,
  MAX_DISPLAY_NAME,
  type Profile,
  type ProfilePatch,
  RATE_PREFERENCES,
  type RatePreference,
  type Settings,
  THEMES,
} from '../../shared/api';
import { type Unchecked, json, fail } from '../http';

/** Each setting's column and allowed values */
const SETTINGS = {
  theme: { column: 'theme', values: THEMES },
  accent: { column: 'accent', values: ACCENTS },
  ratePreference: { column: 'rate_preference', values: RATE_PREFERENCES },
} as const satisfies Record<keyof Settings, unknown>;

type SettingKey = keyof typeof SETTINGS;
type SettingChanges = Partial<Record<SettingKey, string>>;

// A new settings row is written with every one of DEFAULT_SETTINGS (not the table's
// own column defaults), so the defaults can change in shared/api.ts alone.

/** Makes the profile row if there isn't one, so rows that belong to it can be added */
export const ensureProfileStatement = (db: D1Database, email: string) =>
  db
    .prepare('INSERT OR IGNORE INTO profiles (email, created_at, updated_at) VALUES (?1, ?2, ?2)')
    .bind(email, Date.now());

export async function getProfile(db: D1Database, email: string): Promise<Profile> {
  const [profile, settings] = await db.batch([
    db.prepare('SELECT display_name AS displayName FROM profiles WHERE email = ?').bind(email),
    db
      .prepare(
        `SELECT theme, accent, rate_preference AS ratePreference
         FROM user_settings WHERE email = ?`,
      )
      .bind(email),
  ]);
  const saved = settings.results[0] as Settings | undefined;
  return {
    email,
    displayName:
      (profile.results[0] as { displayName: string | null } | undefined)?.displayName ?? null,
    settings: saved ? { ...saved } : { ...DEFAULT_SETTINGS },
  };
}

/** Changes some settings, making the settings row (and profile) on first use */
export function settingsStatements(db: D1Database, email: string, changes: SettingChanges) {
  const keys = Object.keys(changes) as SettingKey[];
  if (keys.length === 0) return [];
  // A first row gets every setting: the changes, and the defaults for the rest. An
  // existing row only has the changed ones updated. Column names come from SETTINGS,
  // never from the request.
  const all = Object.keys(SETTINGS) as SettingKey[];
  const value = (k: SettingKey) => (Object.hasOwn(changes, k) ? changes[k] : DEFAULT_SETTINGS[k]);
  const changed = keys.map((k) => SETTINGS[k].column);
  return [
    ensureProfileStatement(db, email),
    db
      .prepare(
        `INSERT INTO user_settings (email, ${all.map((k) => SETTINGS[k].column).join(', ')}, updated_at)
         VALUES (?, ${all.map(() => '?').join(', ')}, ?)
         ON CONFLICT (email) DO UPDATE SET
           ${changed.map((c) => `${c} = excluded.${c}`).join(', ')},
           updated_at = excluded.updated_at`,
      )
      .bind(email, ...all.map(value), Date.now()),
  ];
}

/** Checks the settings in a request; returns the changes, or the refusal */
function readSettings(raw: unknown): SettingChanges | Response {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Invalid settings', 400);
  }
  const changes: SettingChanges = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(SETTINGS, key)) return fail(`Unknown setting ${key}`, 400);
    const spec = SETTINGS[key as SettingKey];
    if (!(spec.values as readonly unknown[]).includes(value)) return fail(`Invalid ${key}`, 400);
    changes[key as SettingKey] = value as string;
  }
  return changes;
}

/** PATCH /api/me: { displayName?, settings? } */
export async function patchProfile(db: D1Database, email: string, body: Unchecked<ProfilePatch>) {
  const statements: D1PreparedStatement[] = [];

  if ('displayName' in body) {
    const raw = body.displayName;
    if (raw != null && typeof raw !== 'string') return fail('Invalid name', 400);
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length > MAX_DISPLAY_NAME) {
      return fail(`Display name can be up to ${MAX_DISPLAY_NAME} characters`, 400);
    }
    statements.push(
      ensureProfileStatement(db, email),
      db
        .prepare('UPDATE profiles SET display_name = ?, updated_at = ? WHERE email = ?')
        .bind(name || null, Date.now(), email),
    );
  }

  if ('settings' in body) {
    const changes = readSettings(body.settings);
    if (changes instanceof Response) return changes;
    statements.push(...settingsStatements(db, email, changes));
  }

  if (statements.length > 0) await db.batch(statements);
  return json<Profile>(await getProfile(db, email));
}

/** Where someone's exchange rates come from: Wise unless they picked the ECB */
export async function getRatePreference(db: D1Database, email: string): Promise<RatePreference> {
  const row = await db
    .prepare('SELECT rate_preference AS ratePreference FROM user_settings WHERE email = ?')
    .bind(email)
    .first<{ ratePreference: RatePreference }>();
  return row?.ratePreference ?? DEFAULT_SETTINGS.ratePreference;
}
