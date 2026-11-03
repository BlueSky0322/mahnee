import { Button } from '@mantine/core';
import { CloudSlash, SignIn } from '@phosphor-icons/react';
import HomePage from './components/home/HomePage';
import StateCard from './components/ui/StateCard';
import AppLayout from './components/shell/AppLayout';
import { useRoute } from './hooks/useRoute';
import { signIn, useProfile } from './profile/ProfileContext';

// Signing in happens in front of the app (Cloudflare Access), so by the time this
// runs the user is known; /api/me just tells us who
function App() {
  const route = useRoute();
  const { signedOut, unreachable, profile, retry } = useProfile();

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

  return <AppLayout>{route.view === 'home' && <HomePage />}</AppLayout>;
}

export default App;
