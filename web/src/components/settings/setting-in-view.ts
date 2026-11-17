import { useEffect, useState } from 'react';

/**
 * The setting a search opened this section for (?settings=look&setting=homeShows): once
 * it's drawn, it's scrolled into view and takes the keyboard. Answers its key, to mark it.
 */
export function useSettingInView(): string | null {
  const [key] = useState(() => new URLSearchParams(window.location.search).get('setting'));
  useEffect(() => {
    if (key == null || !/^\w+$/.test(key)) return;
    const row = document.querySelector<HTMLElement>(`[data-setting="${key}"]`);
    if (row == null) return;
    row.scrollIntoView({ block: 'center' });
    row.focus();
  }, [key]);
  return key;
}
