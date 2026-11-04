import { useMediaQuery } from '@mantine/hooks';

/** Sidebar layout: 1024px and wider */
export const useIsDesktop = () => useMediaQuery('(min-width: 64em)', window.innerWidth >= 1024);

/** Phone layout: narrower than 768px, where dialogs become bottom sheets */
export const useIsMobile = () => useMediaQuery('(max-width: 47.99em)', window.innerWidth < 768);
