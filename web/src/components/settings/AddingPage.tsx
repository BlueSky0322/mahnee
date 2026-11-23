import { Button } from '@mantine/core';
import { DownIcon, ForwardIcon } from '../ui/icons';
import { useState } from 'react';
import type { StartWith } from '@shared/api';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useAccounts } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { SECTION_NAMES } from './settings-search';
import { SectionHeader } from './SettingsPage';
import { useSettingInView } from './setting-in-view';
import { Choice, OnOff, SettingRow, SettingsLoading } from './setting-parts';
import classes from './Settings.module.css';

const LAST_USED = 'Last used';

// Adding entries (R-Set-Adding, R-Desk-Set-Adding): what the keypad asks for first, the
// account Add starts on (until another is picked), payees suggested as you type, and a time
// asked for on each entry. Each is saved to the account at once, and put back, with a
// message, if it can't be.
export default function AddingPage() {
  const { profile, rememberSettings } = useProfile();
  const { accounts } = useAccounts();
  const isDesktop = useIsDesktop();
  const found = useSettingInView();
  const [picking, setPicking] = useState(false);
  const title = SECTION_NAMES.adding;
  const settings = profile?.settings;
  const running = (accounts ?? []).filter((a) => !a.archived);
  // One archived (or gone) since it was chosen reads as the last one used, as Add takes it
  const chosen = running.find((a) => a.id === settings?.defaultAccountId) ?? null;
  const accountName = chosen?.name ?? LAST_USED;

  return (
    <div className={classes.page}>
      <SectionHeader title={title} />
      {settings == null && <SettingsLoading rows={4} />}
      {settings != null && (
        <section
          className={classes.card}
          aria-label={title}
        >
          <SettingRow
            settingKey="startWith"
            name="Start with"
            line="What the keypad asks for first"
            isNew
            found={found}
          >
            <Choice<StartWith>
              label="Start with"
              value={settings.startWith}
              options={[
                { value: 'amount', label: 'Amount' },
                { value: 'category', label: 'Category' },
              ]}
              onChange={(startWith) => rememberSettings({ startWith })}
            />
          </SettingRow>
          <SettingRow
            settingKey="account"
            name="Account to use"
            line="Until you pick another"
            isNew
            found={found}
            beside
          >
            {isDesktop ? (
              <Button
                variant="default"
                size="xs"
                aria-label={`Account to use: ${accountName}`}
                aria-haspopup="dialog"
                rightSection={<DownIcon size={14} />}
                onClick={() => setPicking(true)}
              >
                {accountName}
              </Button>
            ) : (
              <button
                type="button"
                className={classes.pick}
                onClick={() => setPicking(true)}
              >
                <span className="sr-only">Account to use </span>
                {accountName}
                <ForwardIcon
                  size={16}
                  aria-hidden
                />
              </button>
            )}
          </SettingRow>
          <SettingRow
            settingKey="suggest"
            name="Suggest as you type"
            line="Payees and notes you have used before"
            isNew
            found={found}
            beside
          >
            <OnOff
              label="Suggest as you type"
              checked={settings.suggestAsYouType}
              onChange={(suggestAsYouType) => rememberSettings({ suggestAsYouType })}
            />
          </SettingRow>
          <SettingRow
            settingKey="time"
            name="Ask for a time"
            line="Adds a time to entries"
            isNew
            found={found}
            beside
          >
            <OnOff
              label="Ask for a time"
              checked={settings.askForTime}
              onChange={(askForTime) => rememberSettings({ askForTime })}
            />
          </SettingRow>
        </section>
      )}
      <ResponsiveDialog
        opened={picking}
        onClose={() => setPicking(false)}
        title="Account to use"
      >
        <div
          role="radiogroup"
          aria-label="Account to use"
          className={classes.options}
        >
          {[{ id: null, name: LAST_USED }, ...running].map((a) => (
            <button
              key={a.id ?? 'last'}
              type="button"
              role="radio"
              aria-checked={(chosen?.id ?? null) === a.id}
              className={classes.option}
              onClick={() => {
                setPicking(false);
                if ((chosen?.id ?? null) !== a.id) rememberSettings({ defaultAccountId: a.id });
              }}
            >
              {a.name}
            </button>
          ))}
        </div>
      </ResponsiveDialog>
    </div>
  );
}
