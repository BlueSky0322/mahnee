import { AccountsIcon, ActivityIcon, HomeIcon, PlanIcon, PlusIcon } from '../ui/icons';
import { useEffect } from 'react';
import type { Place } from '../../hooks/useRoute';
import { PLACES, goToPlace, hrefOf } from './places';
import classes from './TabBar.module.css';

const ICONS = { home: HomeIcon, activity: ActivityIcon, plan: PlanIcon, accounts: AccountsIcon };

// The phone's and tablet's places, fixed at the bottom: Home, Activity, Add, Plan and
// Accounts, the open one marked. Add opens a new entry; it waits for the accounts, and
// can't be used while every account is archived. While it shows, --tabbar-h is its height,
// so the page and what floats over it keep clear of it.
export default function TabBar({
  place,
  addable,
  onAdd,
}: {
  place: Place;
  /** null while the accounts load */
  addable: boolean | null;
  onAdd: () => void;
}) {
  useEffect(() => {
    document.documentElement.dataset.tabbar = '';
    return () => {
      delete document.documentElement.dataset.tabbar;
    };
  }, []);

  const tab = ({ place: p, label, address }: (typeof PLACES)[number]) => {
    const Icon = ICONS[p];
    return (
      <a
        key={p}
        href={hrefOf(address)}
        className={classes.tab}
        aria-current={p === place ? 'page' : undefined}
        onClick={(e) => goToPlace(e, address)}
      >
        <Icon
          size={22}
          aria-hidden
        />
        {label}
      </a>
    );
  };

  return (
    <nav
      className={classes.bar}
      aria-label="Main"
    >
      {PLACES.slice(0, 2).map(tab)}
      {addable == null ? (
        <span />
      ) : (
        <button
          type="button"
          className={classes.add}
          aria-label="Add"
          disabled={!addable}
          onClick={onAdd}
        >
          <span className={classes.addSquare}>
            <PlusIcon
              size={24}
              aria-hidden
            />
          </span>
        </button>
      )}
      {PLACES.slice(2).map(tab)}
    </nav>
  );
}
