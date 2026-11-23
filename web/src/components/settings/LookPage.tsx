import type { ExpenseColour, HomeDensity, StartScreen, ThemeSetting } from '@shared/api';
import { ACCENTS } from '@shared/api';
import { ACCENT_NAMES, ACCENT_RAMPS, ACCENT_SHADE } from '@shared/accents';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useProfile } from '../../profile/ProfileContext';
import { SECTION_NAMES } from './settings-search';
import { SectionHeader } from './SettingsPage';
import { useSettingInView } from './setting-in-view';
import { Choice, SettingRow, SettingsLoading } from './setting-parts';
import classes from './Settings.module.css';

// Look and start (R-Set-Look, R-Desk-Set-Look): the theme, the accent buttons and links
// are drawn in, whether spending is in ink or red, how much Home shows (owner decision
// D13) and which page a fresh start opens on (D15). Each is saved to the account at once
// and shown straight away, and put back, with a message, if it can't be saved.
export default function LookPage() {
  const { profile, rememberSettings } = useProfile();
  const isDesktop = useIsDesktop();
  const found = useSettingInView();
  const title = SECTION_NAMES.look;
  const settings = profile?.settings;
  // A computer's board names some controls differently (R-Desk-Set-Look)
  const named = (phone: string, desktop: string) => (isDesktop ? desktop : phone);

  return (
    <div className={classes.page}>
      <SectionHeader title={title} />
      {settings == null && <SettingsLoading rows={5} />}
      {settings != null && (
        <section
          className={classes.card}
          aria-label={title}
        >
          <SettingRow
            settingKey="theme"
            name="Theme"
            line="Saved to your account"
            found={found}
          >
            <Choice<ThemeSetting>
              label="Theme"
              value={settings.theme}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'auto', label: named('Match phone', 'Match device') },
              ]}
              onChange={(theme) => rememberSettings({ theme })}
            />
          </SettingRow>
          <SettingRow
            settingKey="accent"
            name="Accent"
            line="Buttons and links"
            found={found}
          >
            <div
              role="radiogroup"
              aria-label="Accent"
              className={classes.swatches}
            >
              {ACCENTS.map((accent) => (
                <button
                  key={accent}
                  type="button"
                  role="radio"
                  aria-checked={accent === settings.accent}
                  aria-label={ACCENT_NAMES[accent]}
                  className={classes.swatch}
                  onClick={() => {
                    if (accent !== settings.accent) rememberSettings({ accent });
                  }}
                >
                  <span style={{ background: ACCENT_RAMPS[accent][ACCENT_SHADE.light] }} />
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow
            settingKey="expenseColour"
            name="Expenses and income"
            line="Income is always green with a plus"
            isNew
            found={found}
          >
            <Choice<ExpenseColour>
              label={named('Expenses and income', 'Expense colour')}
              value={settings.expenseColour}
              options={[
                { value: 'ink', label: 'Expenses in ink' },
                { value: 'red', label: 'Expenses in red' },
              ]}
              onChange={(expenseColour) => rememberSettings({ expenseColour })}
            />
          </SettingRow>
          <SettingRow
            settingKey="homeShows"
            name="Home shows"
            line="Month end only, or everything"
            isNew
            found={found}
          >
            <Choice<HomeDensity>
              label={named('Home shows', 'Home density')}
              value={settings.homeDensity}
              options={[
                { value: 'essentials', label: 'Essentials' },
                { value: 'everything', label: 'Everything' },
              ]}
              onChange={(homeDensity) => rememberSettings({ homeDensity })}
            />
          </SettingRow>
          <SettingRow
            settingKey="start"
            name="Open the app on"
            line="Where you land each time"
            isNew
            found={found}
          >
            <Choice<StartScreen>
              label={named('Open the app on', 'Start screen')}
              value={settings.startScreen}
              options={[
                { value: 'home', label: 'Home' },
                { value: 'activity', label: 'Activity' },
                { value: 'plan', label: 'Plan' },
              ]}
              onChange={(startScreen) => rememberSettings({ startScreen })}
            />
          </SettingRow>
        </section>
      )}
    </div>
  );
}
