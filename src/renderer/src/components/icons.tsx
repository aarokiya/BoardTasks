import type { ReactElement, ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3 8.5 6.2 11.7 13 4.9" /></Svg>
);
export const IconCheckCircle = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="8" cy="8" r="6.25" /><path d="M5.3 8.2 7.2 10.1 10.8 6.2" /></Svg>
);
export const IconPlus = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M8 3.25v9.5M3.25 8h9.5" /></Svg>
);
export const IconMinus = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3.25 8h9.5" /></Svg>
);
export const IconCalendar = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" /><path d="M2.25 6.25h11.5M5.5 1.9v2.3M10.5 1.9v2.3" /></Svg>
);
export const IconClock = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="8" cy="8" r="6.25" /><path d="M8 4.6V8l2.3 1.6" /></Svg>
);
export const IconFlag = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M4 14V2.6h7.6L10 5.6l1.6 3H4" /></Svg>
);
export const IconList = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M5.5 4.2h8M5.5 8h8M5.5 11.8h8M2.6 4.2h.01M2.6 8h.01M2.6 11.8h.01" /></Svg>
);
export const IconInbox = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M2.25 9.2 4.1 3.4h7.8l1.85 5.8v3.6H2.25z" /><path d="M2.25 9.2h3.1a2.65 2.65 0 0 0 5.3 0h3.1" /></Svg>
);
export const IconSun = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="8" cy="8" r="3.1" /><path d="M8 1.4v1.5M8 13.1v1.5M14.6 8h-1.5M2.9 8H1.4M12.67 3.33l-1.06 1.06M4.39 11.61l-1.06 1.06M12.67 12.67l-1.06-1.06M4.39 4.39 3.33 3.33" /></Svg>
);
export const IconSunrise = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M5.1 10.1a2.9 2.9 0 0 1 5.8 0M8 1.5v2.3M13.1 6.2l-1.4 1.1M2.9 6.2l1.4 1.1M1.6 10.1h1.8M12.6 10.1h1.8M1.9 13.2h12.2" /></Svg>
);
export const IconAlert = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M8 2.3 14.4 13.2H1.6z" /><path d="M8 6.4v3M8 11.4h.01" /></Svg>
);
export const IconInfo = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="8" cy="8" r="6.25" /><path d="M8 7.3v3.7M8 5.1h.01" /></Svg>
);
export const IconGithub = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M6.1 13.6c-2.9.85-2.9-1.45-4.1-1.75m8.2 3.05v-2.3c0-.66.06-.93-.35-1.32 1.9-.21 3.65-.93 3.65-4.03a3.13 3.13 0 0 0-.87-2.17 2.9 2.9 0 0 0-.08-2.19s-.73-.21-2.35.88a8.1 8.1 0 0 0-4.2 0C4.38 2.48 3.65 2.69 3.65 2.69a2.9 2.9 0 0 0-.08 2.19 3.13 3.13 0 0 0-.87 2.19c0 3.07 1.75 3.79 3.65 4.03-.4.39-.39.77-.35 1.32v2.28" />
  </Svg>
);
export const IconCloud = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M4.4 12.4a3 3 0 0 1-.3-5.98 4 4 0 0 1 7.7-1.1 2.95 2.95 0 0 1 .4 5.86l-.3.02z" /></Svg>
);
export const IconCloudOff = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M5.6 4.3a4 4 0 0 1 6.2 2.2 2.95 2.95 0 0 1 1.1 5.2M10.4 12.4H4.4a3 3 0 0 1-.3-5.98c.07-.4.2-.78.37-1.12M1.8 1.8l12.4 12.4" /></Svg>
);
export const IconRefresh = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M13.6 7a5.7 5.7 0 0 0-9.8-2.6L1.9 6.2M2.4 9a5.7 5.7 0 0 0 9.8 2.6l1.9-1.8" /><path d="M1.9 2.9v3.3h3.3M14.1 13.1V9.8h-3.3" /></Svg>
);
export const IconSearch = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="7.1" cy="7.1" r="4.6" /><path d="M10.5 10.5 14 14" /></Svg>
);
export const IconSidebar = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="1.9" y="2.9" width="12.2" height="10.2" rx="2" /><path d="M6.2 2.9v10.2" /></Svg>
);
export const IconInspector = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="1.9" y="2.9" width="12.2" height="10.2" rx="2" /><path d="M9.8 2.9v10.2" /></Svg>
);
export const IconChevronRight = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M6 3.5 10.5 8 6 12.5" /></Svg>
);
export const IconChevronLeft = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M10 3.5 5.5 8 10 12.5" /></Svg>
);
export const IconChevronDown = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3.5 6 8 10.5 12.5 6" /></Svg>
);
export const IconChevronUp = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3.5 10 8 5.5 12.5 10" /></Svg>
);
export const IconX = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3.8 3.8 12.2 12.2M12.2 3.8 3.8 12.2" /></Svg>
);
export const IconTrash = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M2.6 4.2h10.8M5.6 4.2V2.9h4.8v1.3M12.3 4.2l-.6 8.5a1.2 1.2 0 0 1-1.2 1.1H5.5a1.2 1.2 0 0 1-1.2-1.1l-.6-8.5M6.6 6.8v4.4M9.4 6.8v4.4" /></Svg>
);
export const IconEdit = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M11.2 2.4a1.7 1.7 0 0 1 2.4 2.4L5.3 13.1 2 14l.9-3.3z" /><path d="M10.2 3.4 12.6 5.8" /></Svg>
);
export const IconMore = (p: IconProps): ReactElement => (
  <Svg {...p} strokeWidth={0} fill="currentColor"><circle cx="3.4" cy="8" r="1.15" /><circle cx="8" cy="8" r="1.15" /><circle cx="12.6" cy="8" r="1.15" /></Svg>
);
export const IconArrowRight = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M2.6 8h10.8M9.4 4l4 4-4 4" /></Svg>
);
export const IconArrowLeft = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M13.4 8H2.6M6.6 4l-4 4 4 4" /></Svg>
);
export const IconArrowUp = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M8 13.4V2.6M4 6.6l4-4 4 4" /></Svg>
);
export const IconArrowDown = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M8 2.6v10.8M4 9.4l4 4 4-4" /></Svg>
);
export const IconStar = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M8 1.9 9.9 5.8l4.3.63-3.1 3.03.73 4.28L8 11.72l-3.83 2.02.73-4.28-3.1-3.03 4.3-.63z" /></Svg>
);
export const IconTag = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M8.3 1.9H2.4a.5.5 0 0 0-.5.5v5.9c0 .13.05.26.15.35l5.9 5.9a.5.5 0 0 0 .7 0l5.55-5.55a.5.5 0 0 0 0-.7l-5.9-5.9a.5.5 0 0 0-.35-.15z" /><path d="M4.9 4.9h.01" /></Svg>
);
export const IconLink = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M6.6 8.9a2.6 2.6 0 0 0 3.9.28l1.9-1.9a2.6 2.6 0 0 0-3.68-3.68l-1.1 1.1" /><path d="M9.4 7.1a2.6 2.6 0 0 0-3.9-.28l-1.9 1.9a2.6 2.6 0 0 0 3.68 3.68l1.1-1.1" /></Svg>
);
export const IconExternal = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M9.4 2.6h4v4M13.4 2.6 7.6 8.4" /><path d="M12.4 9.6v3a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.6V5a1.4 1.4 0 0 1 1.4-1.4h3" /></Svg>
);
export const IconSettings = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="8" cy="8" r="2.15" /><path d="M12.8 9.9a1.06 1.06 0 0 0 .21 1.17l.04.04a1.28 1.28 0 1 1-1.82 1.82l-.04-.04a1.06 1.06 0 0 0-1.17-.21 1.06 1.06 0 0 0-.64.97v.11a1.28 1.28 0 1 1-2.56 0v-.06a1.06 1.06 0 0 0-.7-.97 1.06 1.06 0 0 0-1.17.21l-.04.04a1.28 1.28 0 1 1-1.82-1.82l.04-.04a1.06 1.06 0 0 0 .21-1.17 1.06 1.06 0 0 0-.97-.64h-.11a1.28 1.28 0 0 1 0-2.56h.06a1.06 1.06 0 0 0 .97-.7 1.06 1.06 0 0 0-.21-1.17l-.04-.04a1.28 1.28 0 1 1 1.82-1.82l.04.04a1.06 1.06 0 0 0 1.17.21h.05a1.06 1.06 0 0 0 .64-.97v-.11a1.28 1.28 0 1 1 2.56 0v.06a1.06 1.06 0 0 0 .64.97 1.06 1.06 0 0 0 1.17-.21l.04-.04a1.28 1.28 0 1 1 1.82 1.82l-.04.04a1.06 1.06 0 0 0-.21 1.17v.05a1.06 1.06 0 0 0 .97.64h.11a1.28 1.28 0 1 1 0 2.56h-.06a1.06 1.06 0 0 0-.97.64z" /></Svg>
);
export const IconSignOut = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M6.2 14H3.4A1.4 1.4 0 0 1 2 12.6V3.4A1.4 1.4 0 0 1 3.4 2h2.8M10.4 11.2 13.6 8l-3.2-3.2M13.6 8H6.2" /></Svg>
);
export const IconKeyboard = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="1.4" y="3.6" width="13.2" height="8.8" rx="1.6" /><path d="M4.2 6.4h.01M6.8 6.4h.01M9.4 6.4h.01M12 6.4h.01M4.2 9.6h7.6" /></Svg>
);
export const IconCopy = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="5.6" y="5.6" width="8.4" height="8.4" rx="1.5" /><path d="M3.1 10.4h-.2A1.4 1.4 0 0 1 1.5 9V3.4A1.4 1.4 0 0 1 2.9 2h5.6A1.4 1.4 0 0 1 9.9 3.4v.2" /></Svg>
);
export const IconDot = (p: IconProps): ReactElement => (
  <Svg {...p} strokeWidth={0} fill="currentColor"><circle cx="8" cy="8" r="3.2" /></Svg>
);
export const IconGrip = (p: IconProps): ReactElement => (
  <Svg {...p} strokeWidth={0} fill="currentColor"><circle cx="6" cy="4" r="1.05" /><circle cx="10" cy="4" r="1.05" /><circle cx="6" cy="8" r="1.05" /><circle cx="10" cy="8" r="1.05" /><circle cx="6" cy="12" r="1.05" /><circle cx="10" cy="12" r="1.05" /></Svg>
);
export const IconNote = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3.2 2.6h9.6v10.8H3.2z" /><path d="M5.6 5.6h4.8M5.6 8h4.8M5.6 10.4h3" /></Svg>
);
export const IconPause = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M6.1 3.4v9.2M9.9 3.4v9.2" /></Svg>
);
export const IconWifi = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M1.6 5.9a9 9 0 0 1 12.8 0M4.1 8.5a5.5 5.5 0 0 1 7.8 0M6.5 11.1a2.1 2.1 0 0 1 3 0M8 13.6h.01" /></Svg>
);
export const IconFolder = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M14 12.1a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.1V3.9a1.3 1.3 0 0 1 1.3-1.3h2.9L7.5 4.4h5.2A1.3 1.3 0 0 1 14 5.7z" /></Svg>
);
