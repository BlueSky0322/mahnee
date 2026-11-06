import { Button } from '@mantine/core';
import { CloudSlash, SignIn } from '@phosphor-icons/react';
import { useEffect } from 'react';
import AccountPage from './components/accounts/AccountPage';
import CategoriesPage from './components/categories/CategoriesPage';
import HomePage from './components/home/HomePage';
import SearchPage from './components/search/SearchPage';
import StateCard from './components/ui/StateCard';
import AppLayout from './components/shell/AppLayout';
import { useRoute } from './hooks/useRoute';
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
    <AppLayout>
      {route.view === 'home' && <HomePage month={route.month} />}
      {route.view === 'categories' && <CategoriesPage />}
      {route.view === 'search' && <SearchPage />}
      {route.view === 'account' && (
        <AccountPage
          key={route.id}
          id={route.id}
        />
      )}
    </AppLayout>
  );
}

export default App;
