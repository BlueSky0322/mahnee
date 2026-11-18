import { createContext, useContext, useEffect, useState } from 'react';

/**
 * The setting a computer's search points at while it's typed: its section is drawn beside
 * the search with that setting marked and in view, the keyboard left in the search
 */
export const PreviewedSetting = createContext<string | null>(null);

/**
 * The setting a search opened this section for (?settings=look&setting=homeShows): once
 * it's drawn, it's scrolled into view and takes the keyboard. Answers its key, to mark it.
 */
export function useSettingInView(): string | null {
  const previewed = useContext(PreviewedSetting);
  const [asked] = useState(() => new URLSearchParams(window.location.search).get('setting'));
  const key = previewed ?? asked;
  useEffect(() => {
    if (key == null || !/^\w+$/.test(key)) return;
    const row = document.querySelector<HTMLElement>(`[data-setting="${key}"]`);
    if (row == null) return;
    row.scrollIntoView({ block: 'center' });
    if (previewed == null) row.focus();
  }, [key, previewed]);
  return key;
}
