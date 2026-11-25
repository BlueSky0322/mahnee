import { runInNewContext } from 'node:vm';
import { readBeside } from './css';

const indexHtml = readBeside('../../index.html', import.meta.url);

export function launchDocument() {
  return new DOMParser().parseFromString(indexHtml, 'text/html');
}

/** Open the page up to its inline appearance script, before React starts. */
export function openLaunchPage(deviceTheme: 'light' | 'dark') {
  const page = launchDocument();
  document.head.innerHTML = page.head.innerHTML;
  document.body.innerHTML = page.body.innerHTML;
  document.documentElement.removeAttribute('data-launch');
  document.documentElement.removeAttribute('data-accent');
  const script = document.head.querySelector('script:not([src])')!;
  runInNewContext(script.textContent, {
    document,
    localStorage,
    matchMedia: (query: string) => ({
      matches: query === `(prefers-color-scheme: ${deviceTheme})`,
    }),
  });
}
