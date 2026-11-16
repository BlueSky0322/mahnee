import { Button } from '@mantine/core';
import { CloudSlash, SignIn } from '@phosphor-icons/react';
import { useEffect } from 'react';
import AccountPage from './components/accounts/AccountPage';
import AccountsPage from './components/accounts/AccountsPage';
import ActivityPage from './components/activity/ActivityPage';
import CategoriesPage from './components/categories/CategoriesPage';
import ImportPage from './components/import/ImportPage';
import HomePage from './components/home/HomePage';
import PlanPage from './components/plan/PlanPage';
import DataPage from './components/settings/DataPage';
import SettingsPage from './components/settings/SettingsPage';
import StateCard from './components/ui/StateCard';
import AppLayout from './components/shell/AppLayout';
import { type SettingsSection as SettingsSectionName, useRoute } from './hooks/useRoute';
import { sendWhenBack } from './ledger/ledger';
import { signIn, useProfile } from './profile/ProfileContext';

// Signing in happens in front of the app (Cloudflare Access), so by the time this
// runs the user is known; /api/me just tells us who
function App() {
  const route = useRoute();
  const { signedOut, unreachable, profile, retry } = useProfile();
  // Changes kept on this device go as soon as the connection, or the person, is back
  useEffect(sendWhenBack, []);

  if (signedOut) {
    return (
      <StateCard
        icon={<SignIn size={36} />}
        title="You're signed out"
        body="Sign in again to carry on."
        action={<Button onClick={signIn}>Sign in</Button>}
      />
    );
  }

  if (unreachable && profile == null) {
    return (
      <StateCard
        icon={<CloudSlash size={36} />}
        title="Couldn't reach Mahnee"
        body="Something went wrong on our side, or with the connection. Try again in a moment."
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  }

  return (
    <AppLayout route={route}>
      {route.view === 'home' && <HomePage month={route.month} />}
      {route.view === 'activity' && <ActivityPage query={route.query} />}
      {route.view === 'plan' && <PlanPage month={route.month} />}
      {route.view === 'accounts' && <AccountsPage />}
      {route.view === 'settings' && <SettingsSection section={route.section} />}
      {route.view === 'import' && <ImportPage />}
      {route.view === 'account' && (
        <AccountPage
          key={route.id}
          id={route.id}
        />
      )}
    </AppLayout>
  );
}

/** A section of Settings; one with no page of its own yet shows Settings itself */
function SettingsSection({ section }: { section: SettingsSectionName | null }) {
  if (section === 'categories') return <CategoriesPage />;
  if (section === 'data') return <DataPage />;
  return <SettingsPage />;
}

export default App;
