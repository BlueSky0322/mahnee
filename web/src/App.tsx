import { Button } from '@mantine/core';
import { CloudSlash } from '@phosphor-icons/react';
import { Suspense, useEffect } from 'react';
import AppLogo from './components/common/AppLogo';
import AccountsPage from './components/accounts/AccountsPage';
import ActivityPage from './components/activity/ActivityPage';
import HomePage from './components/home/HomePage';
import PlanPage from './components/plan/PlanPage';
import ErrorBoundary from './components/ui/ErrorBoundary';
import StateCard from './components/ui/StateCard';
import AppLayout from './components/shell/AppLayout';
import { navigate, useRoute } from './hooks/useRoute';
import { ImportPage, SettingsPage } from './components/shell/lazy-pages';
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
        icon={<AppLogo size={48} />}
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
      {route.view === 'plan' && (
        <PlanPage
          month={route.month}
          half={route.half}
          category={route.category}
        />
      )}
      {(route.view === 'accounts' || route.view === 'account') && (
        <AccountsPage id={route.view === 'account' ? route.id : null} />
      )}
      {(route.view === 'settings' || route.view === 'import') && (
        <ErrorBoundary
          key={route.view}
          fallback={
            <StateCard
              icon={
                <CloudSlash
                  size={36}
                  aria-hidden
                />
              }
              title="Couldn't open this page"
              body="Reload the app to try again."
              action={
                <>
                  <Button onClick={() => window.location.reload()}>Reload app</Button>
                  <Button
                    variant="subtle"
                    onClick={() => navigate('')}
                  >
                    Go to Home
                  </Button>
                </>
              }
            />
          }
        >
          <Suspense
            fallback={
              <p role="status">Loading {route.view === 'settings' ? 'Settings' : 'Import'}…</p>
            }
          >
            {route.view === 'settings' ? <SettingsPage section={route.section} /> : <ImportPage />}
          </Suspense>
        </ErrorBoundary>
      )}
    </AppLayout>
  );
}

export default App;
