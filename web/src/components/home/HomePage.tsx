import { Button } from '@mantine/core';
import {
  CaretRight,
  DownloadSimple,
  MagnifyingGlass,
  SignOut,
  Tag,
  UploadSimple,
} from '@phosphor-icons/react';
import { useState } from 'react';
import AccountList from '../accounts/AccountList';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import Fab from '../ui/Fab';
import { InstallCard } from '../common/InstallApp';
import ThemeToggle from '../common/ThemeToggle';
import Skeleton, { Loading } from '../ui/Skeleton';
import { navigate } from '../../hooks/useRoute';
import { useAccounts } from '../../ledger/useLedger';
import { nameFor, useProfile } from '../../profile/ProfileContext';
import { thisMonth } from '../../utils/date-input';
import ExportDialog from './ExportDialog';
import classes from './HomePage.module.css';
import MonthCard from './MonthCard';
import Staleness from './Staleness';
import { useConfirmSignOut } from './useConfirmSignOut';

// The first screen. It says how old the numbers are when they came from this device. Then
// the month at a glance (`month`, an earlier one; null for this one), the person's
// accounts, the ways to search their transactions, to their categories, to export
// everything and to import a file, then who's signed in and the way out. Add, floating
// over it, opens the entry sheet once there's an account to put a transaction on. Until
// the first account is added there's no month to show.
const HomePage = ({ month }: { month: string | null }) => {
  const { profile } = useProfile();
  const { askToSignOut, dialog } = useConfirmSignOut();
  const { accounts } = useAccounts();
  const [entry, setEntry] = useState<OpenEntry | null>(null);
  const [exporting, setExporting] = useState(false);
  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <h1 className={classes.title}>Mahnee</h1>
        <ThemeToggle />
      </header>
      <Staleness month={month ?? thisMonth()} />
      {accounts?.length !== 0 && <MonthCard month={month} />}
      <InstallCard />
      <AccountList />
      {/* Search is its own page: a button drawn as the same row, like Export */}
      <button
        type="button"
        className={classes.link}
        onClick={() => navigate('?search')}
      >
        <span className={classes.linkIcon}>
          <MagnifyingGlass size={20} />
        </span>
        <span className={classes.linkText}>Search</span>
        <CaretRight
          size={16}
          className={classes.linkCaret}
          aria-hidden
        />
      </button>
      <a
        href="?categories"
        className={classes.link}
        onClick={(e) => {
          e.preventDefault();
          navigate('?categories');
        }}
      >
        <span className={classes.linkIcon}>
          <Tag size={20} />
        </span>
        <span className={classes.linkText}>Categories</span>
        <CaretRight
          size={16}
          className={classes.linkCaret}
          aria-hidden
        />
      </a>
      <button
        type="button"
        className={classes.link}
        onClick={() => setExporting(true)}
      >
        <span className={classes.linkIcon}>
          <DownloadSimple size={20} />
        </span>
        <span className={classes.linkText}>Export</span>
        <CaretRight
          size={16}
          className={classes.linkCaret}
          aria-hidden
        />
      </button>
      <button
        type="button"
        className={classes.link}
        onClick={() => navigate('?import')}
      >
        <span className={classes.linkIcon}>
          <UploadSimple size={20} />
        </span>
        <span className={classes.linkText}>Import</span>
        <CaretRight
          size={16}
          className={classes.linkCaret}
          aria-hidden
        />
      </button>
      <ExportDialog
        opened={exporting}
        onClose={() => setExporting(false)}
      />
      <section className={classes.card}>
        {profile == null ? (
          <Loading
            label="Loading your profile"
            className={classes.loading}
          >
            <Skeleton
              width={180}
              height={20}
            />
            <Skeleton
              width={140}
              height={14}
            />
          </Loading>
        ) : (
          <>
            <p className={classes.lead}>
              Signed in as {nameFor(profile.email, profile.displayName)}
            </p>
            <p className={classes.email}>{profile.email}</p>
          </>
        )}
        <Button
          variant="default"
          leftSection={<SignOut size={16} />}
          onClick={askToSignOut}
        >
          Sign out
        </Button>
        {dialog}
      </section>
      {accounts?.some((a) => !a.archived) && (
        <Fab
          label="Add"
          onClick={() => setEntry({ transaction: null })}
        />
      )}
      <EntrySheet
        open={entry}
        onClose={() => setEntry(null)}
      />
    </div>
  );
};

export default HomePage;
