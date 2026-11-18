import type { ReactNode, SVGProps } from 'react';

// The design's own icons: line drawings on a 24 grid with round ends, 1.8 wide unless the
// design draws one heavier. Each takes a size (20 by default) and the colour of its text.

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number | string;
}

const icon = (paths: ReactNode, strokeWidth = 1.8, ends: 'round' | 'butt' = 'round') => {
  const Icon = ({ size = 20, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap={ends}
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {paths}
    </svg>
  );
  return Icon;
};

// The places
export const HomeIcon = icon(
  <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
);
export const ActivityIcon = icon(
  <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
);
export const PlanIcon = icon(
  <>
    <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z" />
    <path d="M15 3.9A8.5 8.5 0 0 1 20.1 9H15z" />
  </>,
);
export const AccountsIcon = icon(
  <>
    <rect
      x="3"
      y="6"
      width="18"
      height="13"
      rx="3"
    />
    <path d="M3 10.5h18M15.5 15h2" />
  </>,
);
export const SettingsIcon = icon(
  <>
    <circle
      cx="12"
      cy="12"
      r="3"
    />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>,
);

// Kinds of account, drawn with square ends
export const BankIcon = icon(
  <path d="M3 9.5 12 4l9 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />,
  1.8,
  'butt',
);
export const EwalletIcon = icon(
  <>
    <rect
      x="3"
      y="6.5"
      width="18"
      height="11"
      rx="2"
    />
    <circle
      cx="12"
      cy="12"
      r="2.5"
    />
  </>,
  1.8,
  'butt',
);
export const CashIcon = icon(
  <>
    <rect
      x="3"
      y="6.5"
      width="18"
      height="11"
      rx="2"
    />
    <path d="M7 12h.01M17 12h.01" />
    <circle
      cx="12"
      cy="12"
      r="2.5"
    />
  </>,
  1.8,
  'butt',
);
export const CardIcon = icon(
  <>
    <rect
      x="3"
      y="5.5"
      width="18"
      height="13"
      rx="2.5"
    />
    <path d="M3 10h18M7 15h4" />
  </>,
  1.8,
  'butt',
);

// Settings' sections
export const PersonIcon = icon(
  <>
    <circle
      cx="12"
      cy="8.5"
      r="3.8"
    />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </>,
);
export const MoneyIcon = icon(
  <>
    <rect
      x="3"
      y="6"
      width="18"
      height="12"
      rx="2.5"
    />
    <circle
      cx="12"
      cy="12"
      r="2.5"
    />
    <path d="M6.5 9.5v.01M17.5 14.5v.01" />
  </>,
);
export const AddingIcon = icon(
  <>
    <circle
      cx="12"
      cy="12"
      r="8.5"
    />
    <path d="M12 8v8M8 12h8" />
  </>,
);
export const LookIcon = icon(
  <>
    <circle
      cx="12"
      cy="12"
      r="8.5"
    />
    <path
      d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5z"
      fill="currentColor"
    />
  </>,
);
export const BellIcon = icon(
  <>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </>,
);
export const TagIcon = icon(
  <>
    <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z" />
    <circle
      cx="8"
      cy="8"
      r="1.4"
    />
  </>,
);
export const DataIcon = icon(
  <path d="M7 4v13M3.5 13.5 7 17l3.5-3.5M17 20V7M13.5 10.5 17 7l3.5 3.5" />,
);

// Everywhere else
export const BackIcon = icon(<path d="M15 5l-7 7 7 7" />);
export const ForwardIcon = icon(<path d="M9 5l7 7-7 7" />, 2);
export const DownIcon = icon(<path d="M6 9l6 6 6-6" />, 2);
export const SearchIcon = icon(
  <>
    <circle
      cx="11"
      cy="11"
      r="6.5"
    />
    <path d="M16 16l4 4" />
  </>,
);
/** Money going out, and coming in (the kinds of category) */
export const OutIcon = icon(<path d="M7 17L17 7M9 7h8v8" />, 2);
export const InIcon = icon(<path d="M17 7L7 17M15 17H7V9" />, 2);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />, 2.2);
export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2.2);
/** Getting started's done step: a heavier tick */
export const DoneIcon = icon(<path d="M5 12l5 5 9-10" />, 3);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6L6 18" />);
export const AlertIcon = icon(
  <>
    <path d="M12 8v5M12 16.5h.01" />
    <circle
      cx="12"
      cy="12"
      r="9"
    />
  </>,
  2,
);
export const TransferIcon = icon(<path d="M4 8h14l-3-3M20 16H6l3 3" />);
export const TidyIcon = icon(<path d="M4 7h16M7 12h10M10 17h4" />);
export const CalendarIcon = icon(
  <>
    <rect
      x="4"
      y="5"
      width="16"
      height="15"
      rx="3"
    />
    <path d="M4 10h16M9 3v4M15 3v4" />
  </>,
);
/** Nothing scheduled's calendar (R-Empty-Bills) */
export const ScheduledIcon = icon(
  <>
    <rect
      x="3.5"
      y="5"
      width="17"
      height="15"
      rx="2.5"
    />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </>,
);
export const RepeatIcon = icon(
  <>
    <path d="M17 3l3 3-3 3" />
    <path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3" />
    <path d="M20 13v2a3 3 0 0 1-3 3H4" />
  </>,
);
