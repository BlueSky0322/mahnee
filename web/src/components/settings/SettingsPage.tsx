import { Button } from '@mantine/core';
import { ArrowsDownUp, CaretLeft, CaretRight, Tag, X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { closeSettings, navigate } from '../../hooks/useRoute';
import { useShortcuts } from '../../hooks/useShortcuts';
import { thisMonth } from '../../utils/date-input';
import { SettingsFooter } from '../common/Freshness';
import { useConfirmSignOut } from '../common/useConfirmSignOut';
import { useYou } from '../common/you';
import Key from '../ui/Key';
import Skeleton, { Loading } from '../ui/Skeleton';
import classes from './Settings.module.css';

// Settings (?settings): who's signed in, then their data (Categories, and Import and
// export), then Sign out, and at its foot how fresh the figures are ("Mahnee · Up to
// date"). Each section opens today's page for it. It covers the places:
// on phones and tablets it goes back Home; on a computer Close (or Esc) goes back to the
// page it was opened over.
export default function SettingsPage() {
  const isDesktop = useIsDesktop();
  const you = useYou();
  const { askToSignOut, dialog } = useConfirmSignOut();
  useShortcuts({ Escape: closeSettings });

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        {isDesktop ? (
          <button
            type="button"
            className={classes.close}
            aria-label="Close settings"
            onClick={closeSettings}
          >
            <span className={classes.closeIcon}>
              <X size={18} />
            </span>
            <Key>Esc</Key>
          </button>
        ) : (
          <BackButton onClick={closeSettings}>Home</BackButton>
        )}
      </header>
      <h1 className={classes.title}>Settings</h1>

      <section
        className={`${classes.card} ${classes.profile}`}
        aria-label="You"
      >
        {you == null ? (
          <Loading
            label="Loading your profile"
            className={classes.loading}
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
          <>
            <span
              className={classes.initial}
              aria-hidden
            >
              {you.initial}
            </span>
            <span className={classes.rowText}>
              <span className={classes.name}>{you.name}</span>
              <span className={classes.detail}>{you.email}</span>
            </span>
          </>
        )}
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
          address="?settings=categories"
          icon={<Tag size={18} />}
        >
          Categories
        </SectionLink>
        <SectionLink
          address="?settings=data"
          icon={<ArrowsDownUp size={18} />}
        >
          Import and export
        </SectionLink>
      </section>

      <Button
        variant="default"
        className={`sf-danger-outline ${classes.signOut}`}
        onClick={askToSignOut}
      >
        Sign out
      </Button>
      <SettingsFooter month={thisMonth()} />
      {dialog}
    </div>
  );
}

/** A section's row: its icon and name, opening its page */
export function SectionLink({
  address,
  icon,
  children,
}: {
  address: string;
  icon: ReactNode;
  children: ReactNode;
}) {
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
        {icon}
      </span>
      <span className={classes.label}>{children}</span>
      <CaretRight
        size={16}
        className={classes.caret}
        aria-hidden
      />
    </a>
  );
}

/** Back to the page above, named on the button */
export function BackButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button
      variant="subtle"
      color="gray"
      size="compact-md"
      className={classes.back}
      leftSection={<CaretLeft size={16} />}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
