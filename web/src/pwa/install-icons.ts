import type { Accent } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/api';

// Installing the app takes the accent chosen in Look and start: each accent has its own
// manifest, naming icons of its own on a tile of that accent, and its own iPhone icon
// (tools/icons/make-icons.js makes them). The default accent's are the page's own files,
// which the page names before anything is known. index.html's first script names the kept
// accent's before the app loads (install-icons.test.tsx keeps it the same as this), and
// web/public/sw.js keeps every accent's beside the page.

/** What installing the app in `accent` reads: its manifest and the iPhone's icon */
export function installFiles(accent: Accent) {
  if (accent === DEFAULT_SETTINGS.accent) {
    return { manifest: '/manifest.webmanifest', appleTouchIcon: '/apple-touch-icon.png' };
  }
  return {
    manifest: `/manifest-${accent}.webmanifest`,
    appleTouchIcon: `/icons/${accent}/apple-touch-icon.png`,
  };
}

/** Gives the worker the manifest installed in the active accent before it keeps the others. */
export function keepInstallIcons() {
  if (!navigator.onLine || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then(({ active }) => {
      const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
      active?.postMessage({ type: 'keep-install-icons', manifest });
    })
    .catch(() => {});
}

/**
 * Points installing the app at `accent`'s icons: an install prompt, Add to Home Screen, or
 * Android's check on the installed app then reads them
 */
export function showInstallIcons(accent: Accent) {
  const { manifest, appleTouchIcon } = installFiles(accent);
  const point = (rel: string, href: string) => {
    const link = document.querySelector(`link[rel="${rel}"]`);
    if (link != null && link.getAttribute('href') !== href) link.setAttribute('href', href);
  };
  point('manifest', manifest);
  point('apple-touch-icon', appleTouchIcon);
  if (import.meta.env.PROD && document.readyState === 'complete') keepInstallIcons();
}
