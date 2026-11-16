import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { navigate } from '../../hooks/useRoute';

// A link from Home to another page of the app. A place (Activity, Plan) takes Home's place
// in history, as the tab bar does; Settings opens over it, so Back returns (`push`).
export default function PageLink({
  href,
  push = false,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  push?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        // A new tab or window opens as the browser does it
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href, { replace: !push });
      }}
    >
      {children}
    </a>
  );
}
