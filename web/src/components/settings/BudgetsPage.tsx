import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useProfile } from '../../profile/ProfileContext';
import { SECTION_NAMES, SETTINGS_INDEX } from './settings-search';
import { settingValue } from './settings-text';
import { SectionHeader } from './SettingsPage';
import { useSettingInView } from './setting-in-view';
import { OnOff, SettingRow } from './setting-parts';
import classes from './Settings.module.css';

// Budgets and reminders (R-Set-Budgets, R-Desk-Set-Budgets): whether a budget set where
// there was none carries over to start with (each budget can still be changed on its own),
// saved at once. The reminder rows say what's set, read-only, until reminders are sent.
export default function BudgetsPage() {
  const { profile, rememberSettings } = useProfile();
  const isDesktop = useIsDesktop();
  const found = useSettingInView();
  const title = SECTION_NAMES.budgets;
  const settings = profile?.settings;
  const reminders = SETTINGS_INDEX.filter((s) => s.section === 'budgets' && s.key !== 'carryOver');

  return (
    <div className={classes.page}>
      <SectionHeader title={title} />
      {settings != null && (
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
          {reminders.map((s) => (
            <div
              key={s.key}
              className={`${classes.row} ${found === s.key ? classes.found : ''}`}
              data-setting={s.key}
              tabIndex={-1}
            >
              <div className={classes.rowText}>
                <div className={classes.label}>{s.name}</div>
                <div className={classes.detail}>{s.line}</div>
              </div>
              <span className={classes.value}>
                {settingValue(s.key, settings, { desktop: isDesktop })}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
