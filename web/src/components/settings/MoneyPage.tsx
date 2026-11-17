import { Button, Menu } from '@mantine/core';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Category, Recurring, Settings } from '@shared/api';
import { periodMonthOf, periodOf } from '@shared/period';
import { LAST_DAY_OF_MONTH, MAX_MONTH_START_DAY } from '@shared/settings';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { navigate } from '../../hooks/useRoute';
import { forgetMonthTotals } from '../../ledger/ledger';
import { useCategories, useWholeLedger } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { toDateInput } from '../../utils/date-input';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { SETTINGS_INDEX } from './settings-search';
import { ordinal, settingValue } from './settings-text';
import { useSettingInView } from './setting-in-view';
import { SectionHeader } from './SettingsPage';
import classes from './Settings.module.css';
import money from './MoneyPage.module.css';

// Settings › Money (R-Set-Money, R-Desk-Prefs; owner decision D7): the main currency (as it
// is until a home currency can be chosen), when the month starts and when the week
// starts. "Month starts on" opens a sheet on phones and a dialog on computers holding a
// draft: a day of the month (1 to 28, or the last day) or payday, the day a running monthly
// pay in Scheduled is due, with this month's days as a preview. Done keeps it; Cancel,
// Back and Esc keep nothing. Every monthly figure follows it (shared/period.ts), so what
// was kept for the old days goes with it. The week's start is saved as it's picked.
// Settings save through the profile: shown at once, undone with a message on failure.

/** What the month starts on, as chosen in the sheet */
interface Draft {
  mode: Settings['monthStartMode'];
  day: number;
  payId: string | null;
}

/** The pays a month can start on: running monthly income, in the order set up */
const paysIn = (recurring: readonly Recurring[] | undefined) =>
  (recurring ?? []).filter((r) => !r.archived && r.kind === 'income' && r.schedule === 'monthly');

/** A pay as it's offered: "Salary · Acme Sdn Bhd · the 25th" */
function payLabel(pay: Recurring, categories: readonly Category[]) {
  const category = categories.find((c) => c.id === pay.categoryId)?.name;
  return [category, pay.payee, `the ${ordinal(pay.day)}`].filter(Boolean).join(' · ');
}

/** A day as "Nov 25" */
function shortDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The draft the saved settings make: payday only while its pay still fits */
function draftOf(settings: Settings, pays: Recurring[]): Draft {
  const fits = pays.some((p) => p.id === settings.monthStartPayId);
  return {
    mode: settings.monthStartMode === 'payday' && fits ? 'payday' : 'date',
    day: settings.monthStartDay,
    payId: fits ? settings.monthStartPayId : pays[0]?.id ?? null,
  };
}

/** The day a draft starts the month on, null for payday with no pay */
function startOf(draft: Draft, pays: Recurring[]) {
  if (draft.mode === 'date') return draft.day;
  return pays.find((p) => p.id === draft.payId)?.day ?? null;
}

/** "The 1st", "The 25th", "Last day" or "Payday", as the row reads */
const valueOf = (draft: Draft) =>
  draft.mode === 'payday'
    ? 'Payday'
    : draft.day === LAST_DAY_OF_MONTH
      ? 'Last day'
      : `The ${ordinal(draft.day)}`;

/** The settings a draft changes from what's saved; null when it changes nothing */
function changesOf(draft: Draft, saved: Settings): Partial<Settings> | null {
  const changes: Partial<Settings> =
    draft.mode === 'date'
      ? { monthStartMode: 'date', monthStartDay: draft.day }
      : { monthStartMode: 'payday', monthStartPayId: draft.payId };
  const changed = Object.entries(changes).filter(
    ([key, value]) => saved[key as keyof Settings] !== value,
  );
  return changed.length === 0 ? null : Object.fromEntries(changed);
}

export default function MoneyPage() {
  const { profile } = useProfile();
  const { data: ledger, failed } = useWholeLedger();
  // Drawn once the settings and the pays they may name are known, so a search's setting is
  // there to be put in view, and payday reads as payday from the start
  const known = profile != null && (ledger != null || failed);
  return (
    <div className={classes.page}>
      <SectionHeader title="Money" />
      {known && (
        <MoneyCard
          settings={profile.settings}
          pays={paysIn(ledger?.recurring)}
        />
      )}
    </div>
  );
}

function MoneyCard({ settings, pays }: { settings: Settings; pays: Recurring[] }) {
  const { rememberSettings } = useProfile();
  const { categories } = useCategories();
  const isDesktop = useIsDesktop() === true;
  const found = useSettingInView();
  const [draft, setDraft] = useState<Draft | null>(null);
  const row = (key: string) => SETTINGS_INDEX.find((s) => s.key === key)!;
  const rowClass = (key: string) => `${classes.row} ${found === key ? classes.found : ''}`;

  const close = () => setDraft(null);
  const done = () => {
    if (draft == null) return;
    setDraft(null);
    // Payday with no pay to start on keeps what's saved
    if (startOf(draft, pays) == null) return;
    const changes = changesOf(draft, settings);
    if (changes == null) return;
    // Every month's totals kept for the old days go, before anything is fetched again, and
    // again once the save is through (or undone), whichever way it went
    void forgetMonthTotals();
    rememberSettings(changes, (saving) => saving.finally(() => void forgetMonthTotals()));
  };

  const saved = draftOf(settings, pays);
  const currency = row('currency');
  const month = row('monthStart');
  const week = row('weekStart');
  const monthValue = valueOf(saved);

  return (
    <>
      <section
        className={classes.card}
        aria-label="Money"
      >
        <div
          className={rowClass(currency.key)}
          data-setting={currency.key}
          tabIndex={-1}
        >
          <div className={classes.rowText}>
            <div className={classes.label}>{currency.name}</div>
            <div className={classes.detail}>{currency.line}</div>
          </div>
          <span className={classes.value}>{settingValue(currency.key, settings)}</span>
        </div>

        {isDesktop ? (
          <div
            className={rowClass(month.key)}
            data-setting={month.key}
            tabIndex={-1}
          >
            <div className={classes.rowText}>
              <div className={`${classes.label} ${money.named}`}>
                {month.name} <span className={money.new}>New</span>
              </div>
              <div className={classes.detail}>{month.line}</div>
            </div>
            <Button
              variant="default"
              size="compact-md"
              aria-label={`${month.name}: ${monthValue}`}
              aria-haspopup="dialog"
              aria-expanded={draft != null}
              rightSection={<CaretDown size={14} />}
              onClick={() => setDraft(saved)}
            >
              {monthValue}
            </Button>
          </div>
        ) : (
          <div
            className={`${rowClass(month.key)} ${money.rowHolder}`}
            data-setting={month.key}
            tabIndex={-1}
          >
            <button
              type="button"
              className={money.rowButton}
              onClick={() => setDraft(saved)}
            >
              <span className={classes.rowText}>
                <span className={`${classes.label} ${money.named}`}>
                  {month.name} <span className={money.new}>New</span>
                </span>
                <span className={classes.detail}>{month.line}</span>
              </span>
              <span className={classes.value}>{monthValue}</span>
              <CaretRight
                size={16}
                className={classes.caret}
              />
            </button>
          </div>
        )}

        <div
          className={`${rowClass(week.key)} ${money.wrapRow}`}
          data-setting={week.key}
          tabIndex={-1}
        >
          <div className={classes.rowText}>
            <div className={`${classes.label} ${money.named}`}>
              {week.name} <span className={money.new}>New</span>
            </div>
            <div className={classes.detail}>{week.line}</div>
          </div>
          <Segmented
            name={week.name}
            options={[
              ['monday', 'Monday'],
              ['sunday', 'Sunday'],
            ]}
            value={settings.weekStart}
            onPick={(weekStart) => rememberSettings({ weekStart })}
          />
        </div>
      </section>

      <ResponsiveDialog
        opened={draft != null}
        onClose={close}
        title={month.name}
      >
        {draft != null && (
          <MonthSheet
            draft={draft}
            pays={pays}
            categories={categories ?? []}
            isDesktop={isDesktop}
            onChange={setDraft}
            onCancel={close}
            onDone={done}
          />
        )}
      </ResponsiveDialog>
    </>
  );
}

/** "How the month starts", the days or the pay, and this month's days */
function MonthSheet({
  draft,
  pays,
  categories,
  isDesktop,
  onChange,
  onCancel,
  onDone,
}: {
  draft: Draft;
  pays: Recurring[];
  categories: readonly Category[];
  isDesktop: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const start = startOf(draft, pays);
  const today = toDateInput(new Date());
  const range = start == null ? null : periodOf(periodMonthOf(today, start), start);
  const pay = pays.find((p) => p.id === draft.payId);
  const scheduledLink = (
    <a
      href="?plan=scheduled"
      className={money.link}
      onClick={(e) => {
        e.preventDefault();
        navigate('?plan=scheduled');
      }}
    >
      Plan › Scheduled
    </a>
  );
  const doneButton = (
    <Button
      size={isDesktop ? 'compact-md' : 'md'}
      fullWidth={!isDesktop}
      onClick={onDone}
    >
      Done
    </Button>
  );

  return (
    <div className={money.sheet}>
      <Segmented
        name="How the month starts"
        options={[
          ['date', 'A date'],
          ['payday', 'Payday'],
        ]}
        value={draft.mode}
        onPick={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode === 'date' ? (
        <div
          className={money.days}
          role="radiogroup"
          aria-label="Day of the month"
        >
          {[...Array.from({ length: MAX_MONTH_START_DAY }, (_, i) => i + 1), LAST_DAY_OF_MONTH].map(
            (day) => (
              <button
                key={day}
                type="button"
                role="radio"
                aria-checked={draft.day === day}
                className={day === LAST_DAY_OF_MONTH ? money.lastDay : money.day}
                data-on={draft.day === day || undefined}
                onClick={() => onChange({ ...draft, day })}
              >
                {day === LAST_DAY_OF_MONTH ? 'Last day of the month' : day}
              </button>
            ),
          )}
        </div>
      ) : pays.length === 0 ? (
        <div className={money.pay}>
          <p className={money.lands}>No pay is scheduled yet.</p>
          <p className={money.note}>Add one in {scheduledLink}</p>
        </div>
      ) : (
        <div className={money.pay}>
          <p className={money.lands}>Starts when your pay lands</p>
          <span className={money.payHeading}>Your pay</span>
          <Menu position="bottom-start">
            <Menu.Target>
              <Button
                variant="default"
                justify="space-between"
                rightSection={<CaretDown size={14} />}
              >
                {pay == null ? '' : payLabel(pay, categories)}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {pays.map((p) => (
                <Menu.Item
                  key={p.id}
                  onClick={() => onChange({ ...draft, payId: p.id })}
                >
                  {payLabel(p, categories)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <p className={money.note}>
            From {categories.find((c) => c.id === pay?.categoryId)?.name ?? 'your pay'} in{' '}
            {scheduledLink}
          </p>
        </div>
      )}
      {range != null && (
        <div className={money.preview}>
          <span className={money.note}>This month</span>{' '}
          <b>
            {shortDay(range.firstDay)} to {shortDay(range.lastDay)}
          </b>
        </div>
      )}
      <div className={money.actions}>
        {isDesktop && (
          <Button
            variant="subtle"
            size="compact-md"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        {doneButton}
      </div>
    </div>
  );
}

/** Two or more choices side by side, one picked */
function Segmented<T extends string>({
  name,
  options,
  value,
  onPick,
}: {
  name: string;
  options: [T, string][];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div
      className={money.segmented}
      role="radiogroup"
      aria-label={name}
    >
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={money.segment}
          data-on={value === option || undefined}
          onClick={() => onPick(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
