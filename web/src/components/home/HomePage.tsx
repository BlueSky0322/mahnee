import { Button } from '@mantine/core';
import { SignOut } from '@phosphor-icons/react';
import { InstallCard } from '../common/InstallApp';
import ThemeToggle from '../common/ThemeToggle';
import Skeleton, { Loading } from '../ui/Skeleton';
import { nameFor, signOut, useProfile } from '../../profile/ProfileContext';
import classes from './HomePage.module.css';

// The first screen, until there are accounts to show: who's signed in, and the way out
const HomePage = () => {
  const { profile } = useProfile();
  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <h1 className={classes.title}>Mahnee</h1>
        <ThemeToggle />
      </header>
      <InstallCard />
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
        <p className={classes.body}>Your accounts and spending will show here.</p>
        <Button
          variant="default"
          leftSection={<SignOut size={16} />}
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </section>
    </div>
  );
};

export default HomePage;
