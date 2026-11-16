import { Button } from '@mantine/core';
import { ChartPieSlice, GearSix, House, ListBullets, Wallet } from '@phosphor-icons/react';
import type { Place } from '../../hooks/useRoute';
import { navigate } from '../../hooks/useRoute';
import Freshness from '../common/Freshness';
import { useYou } from '../common/you';
import Key from '../ui/Key';
import { PLACES, goToPlace, hrefOf } from './places';
import classes from './Sidebar.module.css';

const ICONS = { home: House, activity: ListBullets, plan: ChartPieSlice, accounts: Wallet };

// The computer's places, down the left of every page: Mahnee and how fresh the figures are
// (judged on `month`, Home's open month or this one), New entry (N), Home,
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
        <span className={classes.name}>Mahnee</span>
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
          {you?.initial}
        </span>
        <span className={classes.settingsText}>
          <span className={classes.settingsTitle}>Settings</span>
          <span className={classes.email}>{you?.email}</span>
        </span>
        <GearSix
          size={18}
          className={classes.gear}
          aria-hidden
        />
      </a>
    </aside>
  );
}
