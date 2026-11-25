import { Button } from '@mantine/core';
import { AccountsIcon, ActivityIcon, HomeIcon, PlanIcon, SettingsIcon } from '../ui/icons';
import type { Place } from '../../hooks/useRoute';
import { navigate } from '../../hooks/useRoute';
import AppLogo from '../common/AppLogo';
import Freshness from '../common/Freshness';
import YouPicture from '../common/YouPicture';
import { useYou } from '../common/you';
import Key from '../ui/Key';
import { PLACES, goToPlace, hrefOf } from './places';
import classes from './Sidebar.module.css';

const ICONS = { home: HomeIcon, activity: ActivityIcon, plan: PlanIcon, accounts: AccountsIcon };

// The computer's places, down the left of every page: Mahnee's logo and name (going Home), how fresh
// the figures are (judged on `month`, Home's open month or this one), New entry (N), Home,
// Activity, Plan and Accounts with the open one marked, and Settings with who's signed in
// at the foot. New entry waits for the accounts, and can't be used while every account is
// archived.
export default function Sidebar({
  place,
  month,
  addable,
  onAdd,
}: {
  place: Place;
  month: string;
  /** null while the accounts load */
  addable: boolean | null;
  onAdd: () => void;
}) {
  const you = useYou();
  return (
    <aside className={classes.sidebar}>
      <div className={classes.brand}>
        {/* Goes to Home, as Home below does: from Home itself, in its place in the history */}
        <a
          href={hrefOf('')}
          className={classes.name}
          aria-label="Mahnee, Home"
          onClick={(e) => goToPlace(e, '')}
        >
          <AppLogo size={22} />
          <span aria-hidden="true">Mahnee</span>
        </a>
        <Freshness month={month} />
      </div>
      {addable != null && (
        <Button
          className={classes.newEntry}
          justify="space-between"
          disabled={!addable}
          rightSection={<Key>N</Key>}
          onClick={onAdd}
        >
          New entry
        </Button>
      )}
      <nav
        className={classes.nav}
        aria-label="Main"
      >
        {PLACES.map(({ place: p, label, address }) => {
          const Icon = ICONS[p];
          return (
            <a
              key={p}
              href={hrefOf(address)}
              className={classes.link}
              aria-current={p === place ? 'page' : undefined}
              onClick={(e) => goToPlace(e, address)}
            >
              <Icon
                size={20}
                aria-hidden
              />
              {label}
            </a>
          );
        })}
      </nav>
      <a
        href="?settings"
        className={`${classes.link} ${classes.settings}`}
        aria-label="Settings: you, categories, import and export"
        onClick={(e) => {
          e.preventDefault();
          navigate('?settings');
        }}
      >
        <span
          className={classes.initial}
          aria-hidden
        >
          {you != null && (
            <YouPicture
              initial={you.initial}
              picture={you.picture}
            />
          )}
        </span>
        <span className={classes.settingsText}>
          <span className={classes.settingsTitle}>Settings</span>
          <span className={classes.email}>{you?.email}</span>
        </span>
        <SettingsIcon
          size={18}
          className={classes.gear}
          aria-hidden
        />
      </a>
    </aside>
  );
}
