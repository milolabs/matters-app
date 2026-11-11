import type { JSX } from "solid-js";

/** Stroke icons on a 16-unit grid, drawn in the text color. Decoration: always aria-hidden. */
function Icon(props: { size?: number; width?: number; children: JSX.Element }) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width={props.width ?? 1.4}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export const SearchIcon = () => (
  <Icon size={14} width={1.5}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </Icon>
);

export const ComposeIcon = () => (
  <Icon>
    <path d="M7.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7.5A1.5 1.5 0 0 0 4 13.5h7.5A1.5 1.5 0 0 0 13 12V8.5" />
    <path d="m11.6 2.4 2 2L8 10l-2.6.6L6 8z" />
  </Icon>
);

/** A speech bubble with a plus: a new talk with the agent, never a new mail (ADR 0086). */
export const NewTalkIcon = () => (
  <Icon>
    <path d="M13.5 7.5c0 2.8-2.5 5-5.5 5-.8 0-1.6-.2-2.3-.5L2.5 13l.9-2.6A4.7 4.7 0 0 1 2.5 7.5c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5Z" />
    <path d="M8 5.25v4.5M5.75 7.5h4.5" />
  </Icon>
);

export const ReplyIcon = () => (
  <Icon>
    <path d="M6.5 3.5 3 7l3.5 3.5M3 7h6.5A3.5 3.5 0 0 1 13 10.5V12" />
  </Icon>
);

/** The mirror of the reply arrow: it points the other way, on, instead of back. */
export const ForwardIcon = () => (
  <Icon>
    <path d="M9.5 3.5 13 7l-3.5 3.5M13 7H6.5A3.5 3.5 0 0 0 3 10.5V12" />
  </Icon>
);

export const ReplyAllIcon = () => (
  <Icon>
    <path d="M8 3.5 4.5 7 8 10.5M4.5 7H10a3 3 0 0 1 3 3v2" />
    <path d="M4.5 3.5 1 7l3.5 3.5" />
  </Icon>
);

/** A box with a lid: put the thread away (ADR 0044). */
export const ArchiveIcon = () => (
  <Icon>
    <rect x="2" y="2.8" width="12" height="3.2" rx="1" />
    <path d="M3.2 6v6.2a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V6M6.4 9h3.2" />
  </Icon>
);

/** A bin: delete (ADR 0044). */
export const TrashIcon = () => (
  <Icon>
    <path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4 4.2l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1M6.6 6.8v3.8M9.4 6.8v3.8" />
  </Icon>
);

/** A stop sign with a mark: report as spam (ADR 0044). */
export const SpamIcon = () => (
  <Icon>
    <path d="M5.4 2h5.2L14 5.4v5.2L10.6 14H5.4L2 10.6V5.4Z" />
    <path d="M8 5.2v3.4M8 10.8v.1" />
  </Icon>
);

/** A folder: move to (ADR 0044). */
export const FolderIcon = () => (
  <Icon>
    <path d="M2.2 4.6a1 1 0 0 1 1-1h2.9l1.3 1.5h5.4a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z" />
  </Icon>
);

/** Three dots in a row: the actions kept one click further away. */
export const MoreIcon = () => (
  <Icon>
    <path d="M3.4 8h.1M8 8h.1M12.5 8h.1" stroke-width="2" />
  </Icon>
);

export const PaperclipIcon = () => (
  <Icon size={13}>
    <path d="m13 7.5-5 5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L10 4.5" />
  </Icon>
);

/** A sheet with a folded corner: a received file in the search panel. */
export const FileIcon = () => (
  <Icon size={13}>
    <path d="M4 1.8h4.6L12 5.2v8.2a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.6A.8.8 0 0 1 4 1.8Z" />
    <path d="M8.4 1.9v3.4h3.4" />
  </Icon>
);

/** An arrow into a tray: save a received file. */
export const SaveIcon = () => (
  <Icon size={14}>
    <path d="M8 2.5v7M5 6.8l3 3 3-3M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />
  </Icon>
);

/** An eye: look at a received file without opening it. */
export const EyeIcon = () => (
  <Icon size={14}>
    <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="1.8" />
    <circle cx="8" cy="8" r="4.4" />
    <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
  </Icon>
);

/** The mark of the app: an open ring, as in the menu bar. */
export const ImageIcon = () => (
  <Icon size={14}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <circle cx="5.5" cy="6.5" r="1" />
    <path d="m2.5 11.5 3-3 2.5 2.5 2-2 3.5 3" />
  </Icon>
);

export const ImageOffIcon = () => (
  <Icon size={14}>
    <path d="M5 3h7.5A1.5 1.5 0 0 1 14 4.5V12M11.5 13h-8A1.5 1.5 0 0 1 2 11.5v-8" />
    <path d="m2.5 11.5 3-3 2 2" />
    <path d="m2 2 12 12" />
  </Icon>
);

export const ChevronDownIcon = () => (
  <Icon size={10} width={1.6}>
    <path d="m4 6 4 4 4-4" />
  </Icon>
);

export const Ring = (props: { size?: number; color?: string }) => (
  <svg width={props.size ?? 14} height={props.size ?? 14} viewBox="0 0 14 14" aria-hidden="true">
    <circle
      cx="7"
      cy="7"
      r="5.25"
      fill="none"
      stroke={props.color ?? "currentColor"}
      stroke-width="2"
      stroke-dasharray="26 7"
      stroke-linecap="round"
      transform="rotate(-50 7 7)"
    />
  </svg>
);

/** All mail, in the agent's prompt and pane (ADR 0064). */
export const TrayIcon = (props: { size?: number }) => (
  <Icon size={props.size ?? 14}>
    <path d="M2.5 9 4 4h8l1.5 5v3.5h-11z" />
    <path d="M2.5 9h3l1 2h3l1-2h3" />
  </Icon>
);

/** A step the app has done. */
export const CheckIcon = (props: { size?: number }) => (
  <Icon size={props.size ?? 12} width={1.6}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);

/** A window with a panel at its right: the agent's column. */
export function PanelIcon() {
  return (
    <Icon>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </Icon>
  );
}

/** Two corners pulled apart: widen the agent's column over the window. */
export function WidenIcon() {
  return (
    <Icon>
      <path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9 7M2.5 13.5 7 9" />
    </Icon>
  );
}

/** Two corners pushed together: the agent's column back to its side. */
export function NarrowIcon() {
  return (
    <Icon>
      <path d="M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5l4.5-4.5M6.5 9.5 2 14" />
    </Icon>
  );
}

/** Closes a notice. */
export const CloseIcon = (props: { size?: number }) => (
  <Icon size={props.size ?? 12} width={1.6}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Icon>
);

/** A banner of the system, in the corner of the screen (ADR 0071). */
export const BannerIcon = (props: { size?: number }) => (
  <Icon size={props.size ?? 14}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <rect x="7.5" y="4.5" width="4.5" height="2.5" rx="0.8" />
  </Icon>
);

/** A notice inside the window, under its toolbar (ADR 0071). */
export const InsideIcon = (props: { size?: number }) => (
  <Icon size={props.size ?? 14}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M2 5.5h12M8 8h4" />
  </Icon>
);

/** The count on the app's icon (ADR 0071). */
export const BadgeIcon = (props: { size?: number }) => (
  <Icon size={props.size ?? 14}>
    <rect x="2.5" y="4.5" width="9" height="9" rx="2.2" />
    <circle cx="12" cy="4" r="2.2" />
  </Icon>
);

/** A shield with a tick: the sender's server vouched for the address (ADR 0078). */
export const ShieldCheckIcon = () => (
  <Icon size={13} width={1.5}>
    <path d="M8 1.8 13 3.6v3.7c0 3.1-2.1 5.6-5 6.9-2.9-1.3-5-3.8-5-6.9V3.6L8 1.8Z" />
    <path d="m5.6 8 1.7 1.7 3.2-3.4" />
  </Icon>
);

/** A shield with an exclamation mark: the sender's authentication failed (ADR 0079). */
export const WarnIcon = () => (
  <Icon size={13} width={1.5}>
    <path d="M8 1.8 13 3.6v3.7c0 3.1-2.1 5.6-5 6.9-2.9-1.3-5-3.8-5-6.9V3.6L8 1.8Z" />
    <path d="M8 5v3.2M8 10.6v.1" />
  </Icon>
);

/**
 * The app's icon, as the system shows it beside a banner: the dark plate, the light M and its
 * violet dot. The M and the dot are those of build/icons/icon.svg (also the loading screen's mark
 * in index.html); the plate's squircle is drawn as a rounded square. Change them together.
 */
export const AppIcon = (props: { size: number }) => (
  <svg width={props.size} height={props.size} viewBox="0 0 100 100" aria-hidden="true">
    <rect width="100" height="100" rx="22.5" fill="#1D1C1F" />
    <path
      fill="#F5F1EA"
      d="M19.1 73.5L19.15 73.89L19.3 74.25L19.54 74.56L19.85 74.8L20.21 74.95L20.6 75L26.6 75L26.99 74.95L27.35 74.8L27.66 74.56L27.9 74.25L28.05 73.89L28.1 73.5L28.1 49.2L28.15 48.83L28.29 48.47L28.52 48.17L28.82 47.93L29.16 47.77L29.54 47.71L29.92 47.74L30.28 47.87L30.59 48.08L30.85 48.37L33.25 51.92L33.77 52.59L34.84 53.83L35.47 54.48L36.73 55.61L38.03 56.61L39.46 57.53L40.25 57.97L41.72 58.68L42.57 59.02L44.17 59.57L45.82 59.98L47.43 60.24L49.12 60.38L50.03 60.4L51.66 60.33L53.35 60.13L54.24 59.96L55.89 59.55L57.49 59L58.99 58.35L59.8 57.94L61.21 57.12L61.97 56.61L63.27 55.61L64.57 54.44L65.69 53.25L66.75 51.92L69.15 48.37L69.41 48.08L69.72 47.87L70.08 47.74L70.46 47.71L70.84 47.77L71.18 47.93L71.48 48.17L71.71 48.47L71.85 48.83L71.9 49.2L71.9 73.5L71.95 73.89L72.1 74.25L72.34 74.56L72.65 74.8L73.01 74.95L73.4 75L79.4 75L79.79 74.95L80.15 74.8L80.46 74.56L80.7 74.25L80.85 73.89L80.9 73.5L80.9 26.5L80.85 26.11L80.7 25.75L80.46 25.44L80.15 25.2L79.79 25.05L79.4 25L74.8 25L74.44 25.04L74.09 25.18L73.79 25.39L73.56 25.66L59.82 46.13L59.23 46.94L58.6 47.66L57.87 48.38L56.79 49.24L55.93 49.79L54.7 50.42L53.75 50.79L52.42 51.15L51.41 51.31L50.03 51.4L49.01 51.36L47.64 51.16L46.65 50.91L45.35 50.44L44.43 50L43.21 49.24L42.13 48.38L41.4 47.66L40.77 46.94L40.18 46.13L26.44 25.66L26.21 25.39L25.91 25.18L25.56 25.04L25.2 25L20.6 25L20.21 25.05L19.85 25.2L19.54 25.44L19.3 25.75L19.15 26.11L19.1 26.5Z"
    />
    <circle cx="50" cy="39.62" r="11.78" fill="#9A88F5" />
  </svg>
);
