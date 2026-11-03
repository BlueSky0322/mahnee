import type { ReactNode } from 'react';
import OfflineNotice from './OfflineNotice';
import UpdateNotice from './UpdateNotice';

// The page, with what floats over it: being offline or signed out, and a new version to
// reload into
const AppLayout = ({ children }: { children: ReactNode }) => (
  <main className="min-h-dvh">
    {children}
    <OfflineNotice />
    <UpdateNotice />
  </main>
);

export default AppLayout;
