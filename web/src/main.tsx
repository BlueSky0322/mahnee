import React from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { Root } from './Root';
import { trackKeyboardInset } from './pwa/keyboard-inset';
import { trackInstall } from './pwa/install';
import { hideLaunchScreen } from './pwa/launch-screen';
import { restoreLastPage } from './hooks/useRoute';
import { dropSignInMark } from './offline/cache';
import { keepStorageOnceInstalled } from './offline/storage';

// Back from signing in: the address as it was, then (on a fresh start) the page that was
// open last time, before anything reads the address
dropSignInMark();
restoreLastPage();
// Bottom sheets stay above the on-screen keyboard
trackKeyboardInset();
// The browser's install prompt comes once, early; keep it for the app's own buttons
trackInstall();
// Once installed, ask the browser not to clear what this device keeps when space runs low
keepStorageOnceInstalled();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<p>Something went wrong</p>}>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
hideLaunchScreen();

// Installable app: the service worker only keeps the built files for offline starts
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Without it, starting offline just doesn't work; the app runs the same otherwise
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
