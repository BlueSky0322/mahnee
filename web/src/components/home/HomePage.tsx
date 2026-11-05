import { Button } from '@mantine/core';
import { CaretRight, SignOut, Tag } from '@phosphor-icons/react';
import AccountList from '../accounts/AccountList';
import { InstallCard } from '../common/InstallApp';
import ThemeToggle from '../common/ThemeToggle';
import Skeleton, { Loading } from '../ui/Skeleton';
import { navigate } from '../../hooks/useRoute';
import { nameFor, useProfile } from '../../profile/ProfileContext';
import classes from './HomePage.module.css';
import { useConfirmSignOut } from './useConfirmSignOut';

// The first screen: the person's accounts, the way to their categories, then who's
// signed in and the way out
const HomePage = () => {
  const { profile } = useProfile();
  const { askToSignOut, dialog } = useConfirmSignOut();
  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <h1 className={classes.title}>Mahnee</h1>
        <ThemeToggle />
      </header>
      <InstallCard />
      <AccountList />
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
    </div>
  );
};

export default HomePage;
