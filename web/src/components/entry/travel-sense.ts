import { onCacheCleared } from '../../offline/cache';
import { quietly } from '../../utils/quietly';

// Travel sense (Settings › Money › Follow where I am; on unless turned off): Add opens in
// the currency of where the person is, for the rest of that day on their own clock. Where
// they are is the device's time zone, when it's in a country whose currency is one of the
// person's other currencies; or, failing that, the currency the last two entries added
// today on this device were in, when that's one of them. It never picks a currency
// outside the person's list. "In THB today. Tap to change." lets them pick the day's
// currency themselves, the main one too. All of it stays on this device, per person, and
// goes on sign-out. Kept apart, so turning it off (or taking it out) touches nothing else.

/**
 * Time zones and the currency of the country they're in, for the currencies an entry can
 * be in (ENTRY_CURRENCIES): the zones people are most likely to find their device in
 */
const ZONE_CURRENCIES: Record<string, string> = {
  'Asia/Bangkok': 'THB',
  'Asia/Singapore': 'SGD',
  'Asia/Kuala_Lumpur': 'MYR',
  'Asia/Kuching': 'MYR',
  'Asia/Jakarta': 'IDR',
  'Asia/Makassar': 'IDR',
  'Asia/Jayapura': 'IDR',
  'Asia/Pontianak': 'IDR',
  'Asia/Manila': 'PHP',
  'Asia/Ho_Chi_Minh': 'VND',
  'Asia/Saigon': 'VND',
  'Asia/Tokyo': 'JPY',
  'Asia/Seoul': 'KRW',
  'Asia/Shanghai': 'CNY',
  'Asia/Chongqing': 'CNY',
  'Asia/Urumqi': 'CNY',
  'Asia/Hong_Kong': 'HKD',
  'Asia/Taipei': 'TWD',
  'Asia/Kolkata': 'INR',
  'Asia/Calcutta': 'INR',
  'Asia/Jerusalem': 'ILS',
  'Asia/Tel_Aviv': 'ILS',
  'Europe/Istanbul': 'TRY',
  'Australia/Sydney': 'AUD',
  'Australia/Melbourne': 'AUD',
  'Australia/Brisbane': 'AUD',
  'Australia/Perth': 'AUD',
  'Australia/Adelaide': 'AUD',
  'Australia/Darwin': 'AUD',
  'Australia/Hobart': 'AUD',
  'Pacific/Auckland': 'NZD',
  'Europe/London': 'GBP',
  'Europe/Zurich': 'CHF',
  'Europe/Prague': 'CZK',
  'Europe/Copenhagen': 'DKK',
  'Europe/Budapest': 'HUF',
  'Atlantic/Reykjavik': 'ISK',
  'Europe/Oslo': 'NOK',
  'Europe/Warsaw': 'PLN',
  'Europe/Bucharest': 'RON',
  'Europe/Stockholm': 'SEK',
  'Europe/Paris': 'EUR',
  'Europe/Berlin': 'EUR',
  'Europe/Madrid': 'EUR',
  'Europe/Rome': 'EUR',
  'Europe/Amsterdam': 'EUR',
  'Europe/Brussels': 'EUR',
  'Europe/Vienna': 'EUR',
  'Europe/Lisbon': 'EUR',
  'Europe/Dublin': 'EUR',
  'Europe/Athens': 'EUR',
  'Europe/Helsinki': 'EUR',
  'Europe/Luxembourg': 'EUR',
  'Europe/Malta': 'EUR',
  'Europe/Tallinn': 'EUR',
  'Europe/Riga': 'EUR',
  'Europe/Vilnius': 'EUR',
  'Europe/Bratislava': 'EUR',
  'Europe/Ljubljana': 'EUR',
  'Europe/Zagreb': 'EUR',
  'Asia/Nicosia': 'EUR',
  'America/New_York': 'USD',
  'America/Chicago': 'USD',
  'America/Denver': 'USD',
  'America/Phoenix': 'USD',
  'America/Los_Angeles': 'USD',
  'America/Anchorage': 'USD',
  'Pacific/Honolulu': 'USD',
  'America/Detroit': 'USD',
  'America/Toronto': 'CAD',
  'America/Vancouver': 'CAD',
  'America/Edmonton': 'CAD',
  'America/Winnipeg': 'CAD',
  'America/Halifax': 'CAD',
  'America/Mexico_City': 'MXN',
  'America/Cancun': 'MXN',
  'America/Sao_Paulo': 'BRL',
  'Africa/Johannesburg': 'ZAR',
};

/** The device's time zone, as it names it; null when it doesn't say */
function deviceZone(): string | null {
  return quietly(() => Intl.DateTimeFormat().resolvedOptions().timeZone) ?? null;
}

const PREFIX = 'mahnee:travel:';

/** What travel sense keeps for a person: the day, its currency once known, today's entries */
interface Day {
  day: string;
  /** The currency Add opens in for the rest of the day, once decided or picked */
  currency: string | null;
  /** The currencies of the last two entries added today, newest last */
  recent: string[];
}

function readDay(email: string, today: string): Day {
  const kept = quietly(() => localStorage.getItem(`${PREFIX}${email}`));
  try {
    const value = kept == null ? null : (JSON.parse(kept) as Partial<Day>);
    if (
      value?.day === today &&
      (value.currency === null || typeof value.currency === 'string') &&
      Array.isArray(value.recent) &&
      value.recent.every((c) => typeof c === 'string')
    ) {
      return { day: today, currency: value.currency, recent: value.recent.slice(-2) };
    }
  } catch {
    // Unreadable: a fresh day
  }
  return { day: today, currency: null, recent: [] };
}

function keepDay(email: string, day: Day) {
  quietly(() => localStorage.setItem(`${PREFIX}${email}`, JSON.stringify(day)));
}

/**
 * The currency Add opens in today, when travel sense picks one other than the home
 * currency; null to open in the home currency
 */
export function travelCurrency({
  email,
  home,
  others,
  on,
  today,
}: {
  email: string | null;
  home: string;
  others: readonly string[];
  on: boolean;
  today: string;
}): string | null {
  if (!on || email == null || others.length === 0) return null;
  const day = readDay(email, today);
  const yours = (c: string | null | undefined) => c != null && others.includes(c) && c !== home;
  // Decided earlier today, or picked: kept for the rest of the day
  if (day.currency != null) return yours(day.currency) ? day.currency : null;
  const zone = deviceZone();
  const local = zone == null ? null : ZONE_CURRENCIES[zone];
  const lastTwo = day.recent.length === 2 && day.recent[0] === day.recent[1] ? day.recent[0] : null;
  const picked = yours(local) ? local! : yours(lastTwo) ? lastTwo! : null;
  if (picked != null) keepDay(email, { ...day, currency: picked });
  return picked;
}

/** Picks today's currency (the home one too), for the rest of the day */
export function pickTodaysCurrency(email: string | null, today: string, currency: string) {
  if (email == null) return;
  keepDay(email, { ...readDay(email, today), currency });
}

/** Notes an entry added today in `currency`, which with the one before may decide the day */
export function noteEntryCurrency(email: string | null, today: string, currency: string) {
  if (email == null) return;
  const day = readDay(email, today);
  keepDay(email, { ...day, recent: [...day.recent, currency].slice(-2) });
}

/** The currencies of the last entries added today on this device, newest first, once each */
export function todaysEntryCurrencies(email: string | null, today: string): string[] {
  if (email == null) return [];
  return [...new Set([...readDay(email, today).recent].reverse())];
}

// Signing out, or someone else signing in: it goes with the rest of what's kept
onCacheCleared(() =>
  quietly(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  }),
);
