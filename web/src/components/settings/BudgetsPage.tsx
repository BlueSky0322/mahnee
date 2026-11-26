import { Button, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { Settings } from '@shared/api';
import { MAX_SCHEDULED_REMINDER_DAYS } from '@shared/settings';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useProfile } from '../../profile/ProfileContext';
import type { DeviceState } from '../../reminders/push-device';
import { useReminderDevice } from '../../reminders/push-device';
import { showError } from '../../utils/notify';
import { SECTION_NAMES, SETTINGS_INDEX } from './settings-search';
import { settingValue } from './settings-text';
import { SectionHeader } from './SettingsPage';
import { useSettingInView } from './setting-in-view';
import { NewTag } from '../ui/Badge';
import { DownIcon } from '../ui/icons';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { OnOff, SettingRow, SettingValueButton, SettingsLoading } from './setting-parts';
import classes from './Settings.module.css';
import own from './BudgetsPage.module.css';

// Budgets and reminders (R-Set-Budgets, R-Desk-Set-Budgets; owner decision D6): whether a
// budget set where there was none carries over to start with (each budget can still be
// changed on its own), then the reminders: daily, at a time of the person's day, when
// nothing was added; and the day (or days) before a scheduled entry. Each is saved at once.
// On a phone the time and the days before are rows of their own; a computer puts the time
// beside the daily switch. Under them, while any reminder is on, how this device stands:
// Allow notifications asks the browser, from that tap only.

/** The days before a scheduled entry a reminder can come: none, or 1 to 7 */
const LEADS: (number | null)[] = [
  null,
  ...Array.from({ length: MAX_SCHEDULED_REMINDER_DAYS }, (_, i) => i + 1),
];

const leadText = (days: number | null) =>
  days == null ? 'Off' : `${days} ${days === 1 ? 'day' : 'days'} before`;

/** What the device row says for each way this device stands */
const DEVICE_LINES: Record<Exclude<DeviceState, 'checking'>, string> = {
  off: 'Allow notifications to get them here',
  on: 'Allowed: they come here',
  blocked: "Notifications are blocked. Allow them for Mahnee in the browser's settings.",
  install: 'Add Mahnee to your Home Screen to get them.',
  unsupported: "This browser can't show notifications.",
};

export default function BudgetsPage() {
  const { profile, rememberSettings } = useProfile();
  const isDesktop = useIsDesktop() === true;
  const found = useSettingInView();
  const title = SECTION_NAMES.budgets;
  const settings = profile?.settings;
  const [picking, setPicking] = useState<'time' | 'lead' | null>(null);
  const entry = (key: string) => SETTINGS_INDEX.find((s) => s.key === key)!;
  const rowClass = (key: string) => `${classes.row} ${found === key ? classes.found : ''}`;

  if (settings == null) {
    return (
      <div className={classes.page}>
        <SectionHeader title={title} />
        <SettingsLoading rows={4} />
      </div>
    );
  }
  const daily = entry('dailyReminder');
  const time = entry('remindAt');
  const lead = entry('beforeScheduled');
  const timeValue = settingValue('remindAt', settings) ?? '';
  const leadValue = leadText(settings.scheduledReminderDays);
  const anyOn = settings.dailyReminder || settings.scheduledReminderDays != null;

  return (
    <div className={classes.page}>
      <SectionHeader title={title} />
      <section
        className={classes.card}
        aria-label={title}
      >
        <SettingRow
          settingKey="carryOver"
          name="Carry over, for new budgets"
          line="Each budget can override"
          isNew
          found={found}
          beside
        >
          <OnOff
            label={isDesktop ? 'Carry over for new budgets' : 'Carry over, for new budgets'}
            checked={settings.carryOverDefault}
            onChange={(carryOverDefault) => rememberSettings({ carryOverDefault })}
          />
        </SettingRow>

        <SettingRow
          settingKey={daily.key}
          name={daily.name}
          line={daily.line}
          isNew
          found={found}
          beside
        >
          <div className={own.controls}>
            {isDesktop && (
              <div
                data-setting={time.key}
                tabIndex={-1}
                className={found === time.key ? classes.found : undefined}
              >
                <Button
                  variant="default"
                  size="xs"
                  aria-label={`Reminder time: ${timeValue}`}
                  rightSection={<DownIcon size={14} />}
                  onClick={() => setPicking('time')}
                >
                  {timeValue}
                </Button>
              </div>
            )}
            <OnOff
              label={isDesktop ? 'Daily reminder' : daily.name}
              checked={settings.dailyReminder}
              onChange={(dailyReminder) => rememberSettings({ dailyReminder })}
            />
          </div>
        </SettingRow>

        {!isDesktop && (
          <SettingValueButton
            settingKey={time.key}
            rowClass={rowClass(time.key)}
            name={time.name}
            titleClass={classes.settingName}
            line={time.line}
            value={timeValue}
            onClick={() => setPicking('time')}
          />
        )}

        {isDesktop ? (
          <SettingRow
            settingKey={lead.key}
            name={lead.name}
            line={lead.line}
            isNew
            found={found}
            beside
          >
            <Button
              variant="default"
              size="xs"
              aria-label={`Remind before scheduled items: ${leadValue}`}
              rightSection={<DownIcon size={14} />}
              onClick={() => setPicking('lead')}
            >
              {leadValue}
            </Button>
          </SettingRow>
        ) : (
          <SettingValueButton
            settingKey={lead.key}
            rowClass={rowClass(lead.key)}
            name={
              <>
                {lead.name} <NewTag />
              </>
            }
            titleClass={classes.settingName}
            line={lead.line}
            value={leadValue}
            onClick={() => setPicking('lead')}
          />
        )}

        {anyOn && profile != null && (
          <ThisDevice
            email={profile.email}
            isDesktop={isDesktop}
          />
        )}
      </section>

      <ResponsiveDialog
        opened={picking === 'time'}
        onClose={() => setPicking(null)}
        title={time.name}
      >
        {picking === 'time' && (
          <TimeForm
            saved={settings.reminderTime}
            onSave={(reminderTime) => {
              setPicking(null);
              if (reminderTime !== settings.reminderTime) rememberSettings({ reminderTime });
            }}
          />
        )}
      </ResponsiveDialog>

      <ResponsiveDialog
        opened={picking === 'lead'}
        onClose={() => setPicking(null)}
        title={lead.name}
      >
        <div
          role="radiogroup"
          aria-label={lead.name}
          className={own.leads}
        >
          {LEADS.map((days) => (
            <label
              key={days ?? 'off'}
              className={own.lead}
            >
              <input
                type="radio"
                name="scheduled-reminder-days"
                checked={settings.scheduledReminderDays === days}
                onChange={() => {
                  setPicking(null);
                  rememberSettings({ scheduledReminderDays: days });
                }}
              />
              {leadText(days)}
            </label>
          ))}
        </div>
      </ResponsiveDialog>
    </div>
  );
}

/** The time a reminder comes, on the person's own clock */
function TimeForm({
  saved,
  onSave,
}: {
  saved: Settings['reminderTime'];
  onSave: (time: string) => void;
}) {
  const [value, setValue] = useState(saved);
  const valid = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
  return (
    <form
      className={own.timeForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(value);
      }}
    >
      <TextInput
        type="time"
        label="Time"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
      />
      <Button
        type="submit"
        disabled={!valid}
      >
        Save
      </Button>
    </form>
  );
}

/** Whether this device gets the reminders, and Allow notifications where it could */
function ThisDevice({ email, isDesktop }: { email: string; isDesktop: boolean }) {
  const { state, turnOn } = useReminderDevice(email);
  const [asking, setAsking] = useState(false);
  if (state === 'checking') return null;
  return (
    <div
      className={classes.row}
      data-setting="reminderDevice"
      tabIndex={-1}
    >
      <div className={classes.rowText}>
        <div className={classes.settingName}>
          {isDesktop ? 'Reminders on this computer' : 'Reminders on this phone'}
        </div>
        <div className={classes.detail}>{DEVICE_LINES[state]}</div>
      </div>
      {state === 'off' && (
        <Button
          size="xs"
          loading={asking}
          onClick={() => {
            setAsking(true);
            turnOn()
              .catch((err: unknown) => showError(err, "Reminders couldn't be turned on here"))
              .finally(() => setAsking(false));
          }}
        >
          Allow notifications
        </Button>
      )}
    </div>
  );
}
