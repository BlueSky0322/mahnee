import { useMediaQuery } from '@mantine/hooks';

/** Sidebar layout: 1024px and wider */
export const useIsDesktop = () => useMediaQuery('(min-width: 64em)', window.innerWidth >= 1024);

/** Phone layout: narrower than 768px, where dialogs become bottom sheets */
export const useIsMobile = () => useMediaQuery('(max-width: 47.99em)', window.innerWidth < 768);

/**
 * A computer wide enough for a page and a pane beside it (Activity's register and its
 * editor): 1200px and wider, the sidebar, the register's 560px and the pane's 300px
 */
export const useIsWide = () => useMediaQuery('(min-width: 75em)', window.innerWidth >= 1200);

/**
 * A short screen (an iPhone SE's 667px, a phone with its browser's bars): Add folds what's
 * optional, so the amount, the keypad and Save show together
 */
export const useIsShort = () => useMediaQuery('(max-height: 50em)', window.innerHeight <= 800);
