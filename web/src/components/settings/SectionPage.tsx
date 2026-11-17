import type { SettingsSection } from '../../hooks/useRoute';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useAccounts } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { SETTINGS_INDEX, SECTION_NAMES } from './settings-search';
import { settingValue } from './settings-text';
import { SectionHeader } from './SettingsPage';
import { useSettingInView } from './setting-in-view';
import classes from './Settings.module.css';

// A section of Settings whose controls come later (Money, until month start lands): each of
// its settings with what it's for and what it's set to, so a search opens it with that
// setting in view
export default function SectionPage({ section }: { section: SettingsSection }) {
  const { profile } = useProfile();
  const { accounts } = useAccounts();
  const isDesktop = useIsDesktop();
  const settings = profile?.settings;
  const accountName = accounts?.find((a) => a.id === settings?.defaultAccountId)?.name ?? null;
  const found = useSettingInView();
  const title = SECTION_NAMES[section];

  return (
    <div className={classes.page}>
      <SectionHeader title={title} />
      <section
        className={classes.card}
        aria-label={title}
      >
        {SETTINGS_INDEX.filter((s) => s.section === section).map((s) => (
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
            {settings != null && (
              <span className={classes.value}>
                {settingValue(s.key, settings, { accountName, desktop: isDesktop })}
              </span>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
