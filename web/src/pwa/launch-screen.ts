// The first screen index.html shows while the app's code loads: the theme's background
// and the logo drawing itself. Once the app is up it fades away, after the logo has
// finished drawing (unless the phone asks for less motion), so it never cuts off midway.

/** When the logo has finished drawing, from the start of the page (index.html's timings) */
const DRAWN_MS = 850;

export function hideLaunchScreen() {
  const launch = document.getElementById('launch');
  if (launch == null) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = still ? 0 : Math.max(0, DRAWN_MS - performance.now());
  setTimeout(() => {
    // Two frames, so the app has painted underneath before the screen goes
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        launch.setAttribute('data-done', '');
        launch.addEventListener('transitionend', () => launch.remove(), { once: true });
        // Removed anyway when no transition runs, as in a tab in the background
        setTimeout(() => launch.remove(), 400);
      }),
    );
  }, wait);
}

/**
 * Keeps the phone's status bar the colour of the app's background (index.html sets it for
 * the first screen), so it follows the theme when it changes
 */
export function syncStatusBar(scheme: 'light' | 'dark') {
  const bar = document.querySelector('meta[name="theme-color"]');
  const background = getComputedStyle(document.documentElement).getPropertyValue('--sf-bg');
  if (bar != null && background.trim() !== '') bar.setAttribute('content', background.trim());
  document.documentElement.setAttribute('data-launch', scheme);
}
