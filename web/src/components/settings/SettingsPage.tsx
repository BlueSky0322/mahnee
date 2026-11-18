import { useThisMonth } from '../../ledger/month-start';
import { Button } from '@mantine/core';
import BackButton from '../ui/BackButton';
import {
  AddingIcon,
  BellIcon,
  CloseIcon,
  DataIcon,
  ForwardIcon,
  LookIcon,
  MoneyIcon,
  PersonIcon,
  TagIcon,
} from '../ui/icons';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { SettingsSection } from '../../hooks/useRoute';
import { closeSettings, goUp, navigate } from '../../hooks/useRoute';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useShortcuts } from '../../hooks/useShortcuts';
import { useCategories, useImports } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { SettingsFooter } from '../common/Freshness';
import { useConfirmSignOut } from '../common/useConfirmSignOut';
import { useYou } from '../common/you';
import Skeleton, { Loading } from '../ui/Skeleton';
import CategoriesPage from '../categories/CategoriesPage';
import AddingPage from './AddingPage';
import BudgetsPage from './BudgetsPage';
import DataPage from './DataPage';
import LookPage from './LookPage';
import MyAccount from './MyAccount';
import MoneyPage from './MoneyPage';
import SectionPage from './SectionPage';
import { SECTION_NAMES, searchSettings } from './settings-search';
import { PreviewedSetting } from './setting-in-view';
import { SearchResults, SettingsSearch } from './SettingsSearch';
import {
  addingSummary,
  budgetsSummary,
  categoriesSummary,
  importsSummary,
  lookSummary,
  moneySummary,
} from './settings-text';
import classes from './Settings.module.css';

// Settings (?settings, and ?settings=<section>). On phones and tablets, the index lists
// who's signed in, each section with what it's set to, then Sign out; each section is a
// page of its own going back up to it, and the index goes back Home. On a computer,
// Settings covers the page: the sections down the left, the open one beside them (My
// account first), and Close (or Esc) goes back to the page it was opened over. Search finds
// a setting by name or by what it's for, and opens its section with that setting in view.

/** Each section's icon, in the order the sections are listed */
const ICONS: Record<SettingsSection, ReactNode> = {
  account: <PersonIcon size={18} />,
  money: <MoneyIcon size={18} />,
  adding: <AddingIcon size={18} />,
  look: <LookIcon size={18} />,
  budgets: <BellIcon size={18} />,
  categories: <TagIcon size={18} />,
  data: <DataIcon size={18} />,
};

const APP_SECTIONS = ['money', 'adding', 'look', 'budgets'] as const;

export default function Settings({ section }: { section: SettingsSection | null }) {
  const isDesktop = useIsDesktop();
  // A computer's Esc closes Settings from any section; a phone's sections go up to Settings
  useShortcuts({
    Escape: isDesktop || section == null ? closeSettings : () => goUp('?settings'),
  });
  if (isDesktop) return <DesktopSettings section={section ?? 'account'} />;
  return section == null ? (
    <SettingsIndex />
  ) : (
    <SectionContent
      // Opened afresh for each address, so a setting asked for comes into view
      key={window.location.search}
      section={section}
    />
  );
}

/** A section's own page, or its pane on a computer */
function SectionContent({ section }: { section: SettingsSection }) {
  if (section === 'account') return <MyAccount />;
  if (section === 'categories') return <CategoriesPage />;
  if (section === 'data') return <DataPage />;
  if (section === 'money') return <MoneyPage />;
  if (section === 'adding') return <AddingPage />;
  if (section === 'look') return <LookPage />;
  if (section === 'budgets') return <BudgetsPage />;
  return <SectionPage section={section} />;
}

/** A phone's index: search, who's signed in, the sections with their summaries, Sign out */
function SettingsIndex() {
  // The person's month (shared/period.ts)
  const month = useThisMonth();
  const you = useYou();
  const { profile } = useProfile();
  const { categories } = useCategories();
  const { imports } = useImports();
  const { askToSignOut, dialog } = useConfirmSignOut();
  const [words, setWords] = useState('');
  const settings = profile?.settings;
  const summaries: Record<(typeof APP_SECTIONS)[number], string> | null =
    settings == null
      ? null
      : {
          money: moneySummary(settings),
          adding: addingSummary(settings),
          look: lookSummary(settings),
          budgets: budgetsSummary(settings),
        };

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <BackButton onClick={closeSettings}>Home</BackButton>
      </header>
      <h1 className={classes.title}>Settings</h1>
      <SettingsSearch
        words={words}
        onChange={setWords}
      />
      {words.trim() !== '' ? (
        <SearchResults
          words={words}
          onOpen={() => setWords('')}
          desktop={false}
        />
      ) : (
        <>
          {you == null ? (
            <Loading
              label="Loading your profile"
              className={`${classes.card} ${classes.profile}`}
            >
              <Skeleton
                circle
                width={48}
                height={48}
              />
              <Skeleton
                width={160}
                height={18}
              />
            </Loading>
          ) : (
            <a
              href="?settings=account"
              className={`${classes.card} ${classes.profile}`}
              onClick={(e) => {
                e.preventDefault();
                navigate('?settings=account');
              }}
            >
              <span
                className={classes.initial}
                aria-hidden
              >
                {you.initial}
              </span>
              <div className={classes.rowText}>
                <div className={classes.name}>{you.name}</div>
                <div className={classes.detail}>{you.email}</div>
              </div>
              <ForwardIcon
                size={16}
                className={classes.caret}
                aria-hidden
              />
            </a>
          )}

          <p
            className={classes.eyebrow}
            aria-hidden
          >
            App
          </p>
          <section
            className={classes.card}
            aria-label="App"
          >
            {APP_SECTIONS.map((s) => (
              <SectionLink
                key={s}
                section={s}
                summary={summaries?.[s] ?? null}
              />
            ))}
          </section>

          <p
            className={classes.eyebrow}
            aria-hidden
          >
            Your data
          </p>
          <section
            className={classes.card}
            aria-label="Your data"
          >
            <SectionLink
              section="categories"
              summary={categories == null ? null : categoriesSummary(categories)}
            />
            <SectionLink
              section="data"
              summary={imports == null ? null : importsSummary(imports)}
            />
          </section>

          <Button
            variant="default"
            className={`sf-danger-outline ${classes.signOut}`}
            onClick={askToSignOut}
          >
            Sign out
          </Button>
          <SettingsFooter month={month} />
        </>
      )}
      {dialog}
    </div>
  );
}

/** A section's row on the index: its icon, name and what it's set to, opening its page */
function SectionLink({ section, summary }: { section: SettingsSection; summary: string | null }) {
  const address = `?settings=${section}`;
  return (
    <a
      href={address}
      className={classes.row}
      onClick={(e) => {
        e.preventDefault();
        navigate(address);
      }}
    >
      <span
        className={classes.icon}
        aria-hidden
      >
        {ICONS[section]}
      </span>
      <div className={classes.rowText}>
        <div className={classes.label}>{SECTION_NAMES[section]}</div>
        {summary != null && <div className={classes.detail}>{summary}</div>}
      </div>
      <ForwardIcon
        size={16}
        className={classes.caret}
        aria-hidden
      />
    </a>
  );
}

/** The parts of a section listed under it on a computer, each its card's heading id */
const PARTS: Partial<Record<SettingsSection, [string, string][]>> = {
  categories: [
    ['Expenses', 'categories-expense'],
    ['Income', 'categories-income'],
  ],
  data: [
    ['Import', 'data-import'],
    ['Export', 'data-export'],
  ],
};

/**
 * A computer's Settings: the sections down the left with search, and Sign out and how fresh
 * the figures are at the foot; the open section beside them. While search is typed, what it
 * finds takes the sections' place, and the first one's section is shown with it marked.
 */
function DesktopSettings({ section }: { section: SettingsSection }) {
  // The person's month (shared/period.ts)
  const month = useThisMonth();
  const [words, setWords] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const { askToSignOut, dialog } = useConfirmSignOut();
  const searching = words.trim() !== '';
  const [first] = searching ? searchSettings(words) : [];

  // Ctrl K (Cmd K on a Mac) finds the search, wherever the keyboard is
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={classes.desktop}>
      <aside className={classes.side}>
        <nav
          className={classes.nav}
          aria-label="Settings"
        >
          <SettingsSearch
            ref={search}
            words={words}
            onChange={setWords}
            desktop
          />
          {searching ? (
            <SearchResults
              words={words}
              onOpen={() => setWords('')}
              desktop
            />
          ) : (
            (['account', ...APP_SECTIONS, 'categories', 'data'] as const).map((s, i) => (
              <NavLink
                key={s}
                section={s}
                current={s === section}
                gapBefore={i === 1 || i === 5}
              />
            ))
          )}
          <hr className={classes.navRule} />
          <button
            type="button"
            className={classes.navSignOut}
            onClick={askToSignOut}
          >
            Sign out
          </button>
          <SettingsFooter month={month} />
        </nav>
      </aside>
      <div className={classes.pane}>
        <button
          type="button"
          className={classes.close}
          aria-label="Close settings"
          onClick={closeSettings}
        >
          <span className={classes.closeIcon}>
            <CloseIcon size={18} />
          </span>
          <span className={classes.closeKey}>Esc</span>
        </button>
        <div className={classes.paneBody}>
          {first != null ? (
            <PreviewedSetting.Provider value={first.key}>
              <SectionContent
                key={`found:${first.section}`}
                section={first.section}
              />
            </PreviewedSetting.Provider>
          ) : (
            <SectionContent
              key={window.location.search}
              section={section}
            />
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}

/** A section in a computer's list of them; moving between them isn't kept in history */
function NavLink({
  section,
  current,
  gapBefore,
}: {
  section: SettingsSection;
  current: boolean;
  gapBefore: boolean;
}) {
  const address = section === 'account' ? '?settings' : `?settings=${section}`;
  const parts = current ? PARTS[section] : undefined;
  return (
    <>
      {gapBefore && <hr className={classes.navGap} />}
      <a
        href={address}
        className={classes.navLink}
        aria-current={current ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          navigate(address, { replace: true });
        }}
      >
        <span aria-hidden>{ICONS[section]}</span>
        {SECTION_NAMES[section]}
      </a>
      {parts != null && (
        <SectionParts
          name={SECTION_NAMES[section]}
          parts={parts}
        />
      )}
    </>
  );
}

/**
 * The open section's parts (Categories: Expenses and Income), each bringing its card into
 * view with the keyboard on it; the last one asked for is marked
 */
function SectionParts({ name, parts }: { name: string; parts: [string, string][] }) {
  const [at, setAt] = useState(0);
  return (
    <div
      role="group"
      aria-label={`Parts of ${name}`}
      className={classes.navParts}
    >
      {parts.map(([label, headingId], i) => (
        <button
          key={headingId}
          type="button"
          className={classes.navPart}
          aria-current={i === at ? 'true' : undefined}
          onClick={() => {
            setAt(i);
            const card = document.getElementById(headingId)?.closest<HTMLElement>('section');
            if (card == null) return;
            card.scrollIntoView({ block: 'start', behavior: 'smooth' });
            card.focus({ preventScroll: true });
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A section's heading: on phones and tablets with Settings to go back to, on a computer
 * alone (Settings' Close is beside it). `actions` sit at the right.
 */
export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const isDesktop = useIsDesktop();
  return (
    <>
      {!isDesktop && (
        <header className={classes.header}>
          <BackButton onClick={() => goUp('?settings')}>Settings</BackButton>
          {actions != null && <span className={classes.headerActions}>{actions}</span>}
        </header>
      )}
      <div className={classes.titleRow}>
        <h1 className={classes.title}>{title}</h1>
        {isDesktop && actions != null && <span className={classes.headerActions}>{actions}</span>}
      </div>
    </>
  );
}
