import type { SettingsSection } from '../../hooks/useRoute';

// Searching settings (R-Set-Search): every setting the person can find, its section, the
// line under its name, and words a person might search for that aren't on it. A setting
// whose name holds the words comes first; then the others, each quoting where the words
// were found: its other words first, then its line.

/** Each section of Settings as it's named */
export const SECTION_NAMES: Record<SettingsSection, string> = {
  account: 'My account',
  money: 'Money',
  adding: 'Adding entries',
  look: 'Look and start',
  budgets: 'Budgets and reminders',
  categories: 'Categories',
  data: 'Import and export',
};

export interface SettingEntry {
  /** Names it in the address, ?settings=money&setting=monthStart */
  key: string;
  section: SettingsSection;
  name: string;
  /** The line under its name */
  line: string;
  /** Words that find it though they aren't on it, as they're quoted */
  words: string[];
}

/** Every setting that can be searched for, in the order of their sections and pages */
export const SETTINGS_INDEX: SettingEntry[] = [
  {
    key: 'name',
    section: 'account',
    name: 'Your name',
    line: 'Shown in Settings',
    words: ['display name', 'change name'],
  },
  {
    key: 'install',
    section: 'account',
    name: 'Install the app',
    line: 'Opens offline',
    words: ['home screen'],
  },
  {
    key: 'currency',
    section: 'money',
    name: 'Main currency',
    line: 'For totals and budgets',
    words: ['the month end', 'home currency', 'ringgit'],
  },
  {
    key: 'otherCurrencies',
    section: 'money',
    name: 'Other currencies',
    line: 'Each entry keeps its rate',
    words: ['foreign currency', 'travel', 'exchange rate'],
  },
  {
    key: 'travelSense',
    section: 'money',
    name: 'Follow where I am',
    line: 'Add opens in the local currency for the day',
    words: ['travel', 'abroad', 'time zone'],
  },
  {
    key: 'monthStart',
    section: 'money',
    name: 'Month starts on',
    line: 'When budgets reset',
    words: ['payday', 'period'],
  },
  {
    key: 'weekStart',
    section: 'money',
    name: 'Week starts on',
    line: 'For the calendar on Home',
    words: ['monday', 'sunday'],
  },
  {
    key: 'startWith',
    section: 'adding',
    name: 'Start with',
    line: 'What the keypad asks for first',
    words: ['amount first', 'category first'],
  },
  {
    key: 'account',
    section: 'adding',
    name: 'Account to use',
    line: 'Until you pick another',
    words: ['default account', 'last used'],
  },
  {
    key: 'suggest',
    section: 'adding',
    name: 'Suggest as you type',
    line: 'Payees and notes you have used before',
    words: ['autocomplete', 'suggestions'],
  },
  {
    key: 'time',
    section: 'adding',
    name: 'Ask for a time',
    line: 'Adds a time to entries',
    words: ['clock', 'time of day'],
  },
  {
    key: 'theme',
    section: 'look',
    name: 'Theme',
    line: 'Saved to your account',
    words: ['dark mode', 'light mode', 'match phone'],
  },
  {
    key: 'accent',
    section: 'look',
    name: 'Accent',
    line: 'Buttons and links',
    words: ['colour', 'color'],
  },
  {
    key: 'expenseColour',
    section: 'look',
    name: 'Expenses and income',
    line: 'Income is always green with a plus',
    words: ['expense colour', 'red'],
  },
  {
    key: 'homeShows',
    section: 'look',
    name: 'Home shows',
    line: 'Month end only, or everything',
    words: ['the month-end figure', 'density', 'essentials'],
  },
  {
    key: 'start',
    section: 'look',
    name: 'Open the app on',
    line: 'Where you land each time',
    words: ['start screen'],
  },
  {
    key: 'carryOver',
    section: 'budgets',
    name: 'Carry over, for new budgets',
    line: 'Each budget can override',
    words: ['leftover', 'roll over'],
  },
  {
    key: 'dailyReminder',
    section: 'budgets',
    name: 'Daily reminder to log',
    line: "If nothing's added that day",
    words: ['notification', 'push'],
  },
  {
    key: 'remindAt',
    section: 'budgets',
    name: 'Remind me at',
    line: 'When reminders come, each day',
    words: ['reminder time'],
  },
  {
    key: 'beforeScheduled',
    section: 'budgets',
    name: 'Heads-up before scheduled entries',
    line: 'A notification before a scheduled bill or income is added',
    words: ['bills', 'scheduled reminder', 'before one is added', 'warn'],
  },
];

export interface SettingResult {
  key: string;
  name: string;
  section: SettingsSection;
  sectionName: string;
  /** Where the words were found when not in its name, quoted; null for its name */
  phrase: string | null;
  /** The words as found, in its name or in the phrase: marked */
  matched: { in: 'name' | 'phrase'; start: number; length: number };
}

/** The settings `words` find (ignoring case and the spaces around them), as they're listed */
export function searchSettings(words: string): SettingResult[] {
  const wanted = words.trim().toLowerCase();
  if (wanted === '') return [];
  const byName: SettingResult[] = [];
  const byPhrase: SettingResult[] = [];
  for (const entry of SETTINGS_INDEX) {
    const base = {
      key: entry.key,
      name: entry.name,
      section: entry.section,
      sectionName: SECTION_NAMES[entry.section],
    };
    const inName = entry.name.toLowerCase().indexOf(wanted);
    if (inName >= 0) {
      byName.push({
        ...base,
        phrase: null,
        matched: { in: 'name', start: inName, length: wanted.length },
      });
      continue;
    }
    const phrase = [...entry.words, entry.line].find((p) => p.toLowerCase().includes(wanted));
    if (phrase == null) continue;
    byPhrase.push({
      ...base,
      phrase,
      matched: { in: 'phrase', start: phrase.toLowerCase().indexOf(wanted), length: wanted.length },
    });
  }
  return [...byName, ...byPhrase];
}
