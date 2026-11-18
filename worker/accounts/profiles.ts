// The account's profile (its display name and picture) and settings (private preferences
// that follow it between devices). A profile row is made the first time someone saves
// anything; until then everything has its default.

import {
  DEFAULT_SETTINGS,
  MAX_DISPLAY_NAME,
  PICTURE_CHOICES,
  type PictureChoice,
  type Profile,
  type ProfilePatch,
  type RatePreference,
  type Settings,
} from '../../shared/api';
import { readSettingChanges } from '../../shared/settings';
import { type Unchecked, json, fail } from '../http';
import {
  type PictureRow,
  choosePictureStatements,
  fetchGooglePicture,
  keepPictureStatement,
  pictureRowsStatement,
  readPicture,
  shownPicture,
} from './pictures';

/** Each setting's column; yes-or-no settings are kept as 1 or 0 */
const SETTINGS = {
  theme: 'theme',
  accent: 'accent',
  ratePreference: 'rate_preference',
  weekStart: 'week_start',
  monthStartMode: 'month_start_mode',
  monthStartDay: 'month_start_day',
  monthStartPayId: 'month_start_pay_id',
  startScreen: 'start_screen',
  homeDensity: 'home_density',
  startWith: 'start_with',
  defaultAccountId: 'default_account_id',
  suggestAsYouType: 'suggest_as_you_type',
  askForTime: 'ask_for_time',
  expenseColour: 'expense_colour',
  carryOverDefault: 'carry_over_default',
  dailyReminder: 'daily_reminder',
  reminderTime: 'reminder_time',
  scheduledReminderDays: 'scheduled_reminder_days',
  timeZone: 'time_zone',
} as const satisfies Record<keyof Settings, string>;

type SettingKey = keyof typeof SETTINGS;
const KEYS = Object.keys(SETTINGS) as SettingKey[];

/** The yes-or-no settings, kept as 1 or 0 */
const FLAGS = new Set<SettingKey>([
  'suggestAsYouType',
  'askForTime',
  'carryOverDefault',
  'dailyReminder',
]);

const toColumn = (key: SettingKey, value: Settings[SettingKey]) =>
  FLAGS.has(key) ? (value ? 1 : 0) : (value as string | number | null);

/** The settings as one row of user_settings holds them */
const SELECT_SETTINGS = `SELECT ${KEYS.map((k) => `${SETTINGS[k]} AS ${k}`).join(', ')}
  FROM user_settings WHERE email = ?`;

function fromRow(row: Record<string, unknown>): Settings {
  const settings = { ...row };
  for (const key of FLAGS) settings[key] = row[key] === 1;
  return settings as unknown as Settings;
}

// A new settings row is written with every one of DEFAULT_SETTINGS (not the table's
// own column defaults), so the defaults can change in shared/api.ts alone. Values are
// checked (shared/settings.ts) before they get here, and the table's CHECKs hold the same.

/** Makes the profile row if there isn't one, so rows that belong to it can be added */
export const ensureProfileStatement = (db: D1Database, email: string) =>
  db
    .prepare('INSERT OR IGNORE INTO profiles (email, created_at, updated_at) VALUES (?1, ?2, ?2)')
    .bind(email, Date.now());

export async function getProfile(db: D1Database, email: string): Promise<Profile> {
  const [profile, settings, pictures] = await db.batch([
    db
      .prepare(
        'SELECT display_name AS displayName, google_picture AS google FROM profiles WHERE email = ?',
      )
      .bind(email),
    db.prepare(SELECT_SETTINGS).bind(email),
    pictureRowsStatement(db, email),
  ]);
  const row = settings.results[0] as Record<string, unknown> | undefined;
  const saved = profile.results[0] as { displayName: string | null; google: number } | undefined;
  return {
    email,
    displayName: saved?.displayName ?? null,
    settings: row ? fromRow(row) : { ...DEFAULT_SETTINGS },
    // The Google picture shows until they ask for the initial
    ...shownPicture(pictures.results as unknown as PictureRow[], saved?.google !== 0),
  };
}

/**
 * Copies the Google picture the sign-in names when it's new (fetchGooglePicture). Run
 * after GET /api/me has answered, so a slow Google never holds up the app's start; the
 * picture shows from the next start.
 */
export async function copyGooglePicture(
  db: D1Database,
  email: string,
  googlePicture: string,
  googleBase?: string,
) {
  const keep = await fetchGooglePicture(db, email, googlePicture, googleBase);
  if (keep != null) await db.batch([ensureProfileStatement(db, email), keep]);
}

/** PUT /api/me/picture: the picture's bytes, checked, kept as the one the person chose */
export async function putPicture(db: D1Database, email: string, req: Request) {
  const picture = await readPicture(req);
  if (picture instanceof Response) return picture;
  await db.batch([
    ensureProfileStatement(db, email),
    keepPictureStatement(db, email, 'upload', picture, null),
  ]);
  return json<Profile>(await getProfile(db, email));
}

/** Changes some settings, making the settings row (and profile) on first use */
export function settingsStatements(db: D1Database, email: string, changes: Partial<Settings>) {
  const keys = Object.keys(changes) as SettingKey[];
  if (keys.length === 0) return [];
  // A first row gets every one of the defaults, then the changes are made to the row as
  // it is: a row is never written with a change beside defaults it doesn't fit (payday
  // with no pay). Column names come from SETTINGS, never from the request.
  const now = Date.now();
  return [
    ensureProfileStatement(db, email),
    db
      .prepare(
        `INSERT OR IGNORE INTO user_settings (email, ${KEYS.map((k) => SETTINGS[k]).join(', ')}, updated_at)
         VALUES (?, ${KEYS.map(() => '?').join(', ')}, ?)`,
      )
      .bind(email, ...KEYS.map((k) => toColumn(k, DEFAULT_SETTINGS[k])), now),
    db
      .prepare(
        `UPDATE user_settings SET ${keys.map((k) => `${SETTINGS[k]} = ?`).join(', ')}, updated_at = ?
         WHERE email = ?`,
      )
      .bind(...keys.map((k) => toColumn(k, changes[k] as Settings[SettingKey])), now, email),
  ];
}

/**
 * Checks the settings in a request, and the rows they name among the person's own: the
 * account Add starts on (not archived), and the pay a month starts on (a running monthly
 * income), which payday needs. Returns the changes, or the refusal.
 */
async function readSettings(
  db: D1Database,
  email: string,
  raw: unknown,
): Promise<Partial<Settings> | Response> {
  const changes = readSettingChanges(raw);
  if ('error' in changes) return fail(changes.error, 400);

  if (changes.defaultAccountId != null) {
    const account = await db
      .prepare('SELECT archived FROM accounts WHERE email = ? AND id = ?')
      .bind(email, changes.defaultAccountId)
      .first<{ archived: number }>();
    if (account == null) return fail('Account not found', 404);
    if (account.archived === 1) return fail('That account is archived', 400);
  }

  if ('monthStartMode' in changes || 'monthStartPayId' in changes) {
    const saved = await db
      .prepare(
        'SELECT month_start_mode AS mode, month_start_pay_id AS payId FROM user_settings WHERE email = ?',
      )
      .bind(email)
      .first<{ mode: Settings['monthStartMode']; payId: string | null }>();
    const mode = changes.monthStartMode ?? saved?.mode ?? DEFAULT_SETTINGS.monthStartMode;
    const payId =
      changes.monthStartPayId !== undefined
        ? changes.monthStartPayId
        : saved?.payId ?? DEFAULT_SETTINGS.monthStartPayId;
    if (mode === 'payday' && payId == null) return fail('Pick the pay the month starts on', 400);
    if (payId != null && (changes.monthStartPayId != null || mode === 'payday')) {
      const pay = await db
        .prepare('SELECT kind, schedule, archived FROM recurring WHERE email = ? AND id = ?')
        .bind(email, payId)
        .first<{ kind: string; schedule: string; archived: number }>();
      if (pay == null) return fail('Repeating item not found', 404);
      if (pay.kind !== 'income') return fail('The month can start only on income', 400);
      if (pay.schedule !== 'monthly') {
        return fail('The month can start only on a monthly pay', 400);
      }
      if (pay.archived === 1) return fail('That pay no longer repeats', 400);
    }
  }
  return changes;
}

/** PATCH /api/me: { displayName?, settings?, picture? } */
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

  if ('picture' in body) {
    if (!(PICTURE_CHOICES as readonly unknown[]).includes(body.picture)) {
      return fail('Pick the Google picture or the initial', 400);
    }
    statements.push(
      ensureProfileStatement(db, email),
      ...choosePictureStatements(db, email, body.picture as PictureChoice),
    );
  }

  if ('settings' in body) {
    const changes = await readSettings(db, email, body.settings);
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
