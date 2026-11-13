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

/** One master of the mark (docs/brand/mark): its box, the M and the ball, in the plate's units. */
export interface MarkMaster {
  readonly viewBox: string;
  /** Width over height of the box. */
  readonly aspect: number;
  readonly m: string;
  readonly ball: { readonly cx: number; readonly cy: number; readonly r: number };
}

/** The regular master, 48 px and up. */
const MARK_REGULAR: MarkMaster = {
  viewBox: "19.1 25 61.8 50",
  aspect: 61.8 / 50,
  m: "M19.1 73.5L19.15 73.89L19.3 74.25L19.54 74.56L19.85 74.8L20.21 74.95L20.6 75L26.6 75L26.99 74.95L27.35 74.8L27.66 74.56L27.9 74.25L28.05 73.89L28.1 73.5L28.1 49.2L28.15 48.83L28.29 48.47L28.52 48.17L28.82 47.93L29.16 47.77L29.54 47.71L29.92 47.74L30.28 47.87L30.59 48.08L30.85 48.37L33.25 51.92L33.77 52.59L34.84 53.83L35.47 54.48L36.73 55.61L38.03 56.61L39.46 57.53L40.25 57.97L41.72 58.68L42.57 59.02L44.17 59.57L45.82 59.98L47.43 60.24L49.12 60.38L50.03 60.4L51.66 60.33L53.35 60.13L54.24 59.96L55.89 59.55L57.49 59L58.99 58.35L59.8 57.94L61.21 57.12L61.97 56.61L63.27 55.61L64.57 54.44L65.69 53.25L66.75 51.92L69.15 48.37L69.41 48.08L69.72 47.87L70.08 47.74L70.46 47.71L70.84 47.77L71.18 47.93L71.48 48.17L71.71 48.47L71.85 48.83L71.9 49.2L71.9 73.5L71.95 73.89L72.1 74.25L72.34 74.56L72.65 74.8L73.01 74.95L73.4 75L79.4 75L79.79 74.95L80.15 74.8L80.46 74.56L80.7 74.25L80.85 73.89L80.9 73.5L80.9 26.5L80.85 26.11L80.7 25.75L80.46 25.44L80.15 25.2L79.79 25.05L79.4 25L74.8 25L74.44 25.04L74.09 25.18L73.79 25.39L73.56 25.66L59.82 46.13L59.23 46.94L58.6 47.66L57.87 48.38L56.79 49.24L55.93 49.79L54.7 50.42L53.75 50.79L52.42 51.15L51.41 51.31L50.03 51.4L49.01 51.36L47.64 51.16L46.65 50.91L45.35 50.44L44.43 50L43.21 49.24L42.13 48.38L41.4 47.66L40.77 46.94L40.18 46.13L26.44 25.66L26.21 25.39L25.91 25.18L25.56 25.04L25.2 25L20.6 25L20.21 25.05L19.85 25.2L19.54 25.44L19.3 25.75L19.15 26.11L19.1 26.5Z",
  ball: { cx: 50, cy: 39.62, r: 11.78 },
};

/** The small master, 24 to 47 px: a thicker stroke. */
const MARK_SMALL: MarkMaster = {
  viewBox: "19.1 21.6 61.8 53.4",
  aspect: 61.8 / 53.4,
  m: "M19.1 73.17L19.16 73.64L19.35 74.08L19.64 74.46L20.02 74.75L20.46 74.94L20.93 75L28.27 75L28.74 74.94L29.18 74.75L29.56 74.46L29.85 74.08L30.04 73.64L30.1 73.17L30.1 56.38L30.16 55.91L30.34 55.48L30.62 55.1L30.99 54.81L31.42 54.62L31.89 54.55L32.69 54.6L34.03 55.75L34.94 56.45L36.85 57.73L38.94 58.86L41.05 59.77L43.23 60.48L45.47 60.99L47.75 61.3L50.04 61.4L52.34 61.29L54.61 60.98L56.85 60.46L59.03 59.74L61.06 58.86L62.16 58.3L64.05 57.16L65 56.5L67.21 54.76L67.65 54.59L68.11 54.55L68.58 54.62L69.01 54.81L69.38 55.1L69.66 55.48L69.84 55.91L69.9 56.38L69.9 73.17L69.96 73.64L70.15 74.08L70.44 74.46L70.82 74.75L71.26 74.94L71.73 75L79.07 75L79.54 74.94L79.98 74.75L80.36 74.46L80.65 74.08L80.84 73.64L80.9 73.17L80.9 26.83L80.84 26.36L80.65 25.92L80.36 25.54L79.98 25.25L79.54 25.06L79.07 25L73.19 25L72.7 25.07L72.24 25.26L71.86 25.57L71.57 25.98L62.76 42.68L61.73 44.34L60.88 45.43L59.98 46.38L58.55 47.58L57.4 48.35L56.25 48.97L54.52 49.67L53.19 50.04L51.34 50.34L50.04 50.4L48.74 50.34L47.37 50.16L45.56 49.7L44.26 49.2L42.6 48.35L41.45 47.58L40.44 46.76L39.12 45.43L38.27 44.34L37.24 42.68L28.43 25.98L28.14 25.57L27.76 25.26L27.3 25.07L26.81 25L20.93 25L20.46 25.06L20.02 25.25L19.64 25.54L19.35 25.92L19.16 26.36L19.1 26.83Z",
  ball: { cx: 50, cy: 36, r: 14.4 },
};

/** The micro master, 16 to 23 px: thicker still. */
const MARK_MICRO: MarkMaster = {
  viewBox: "16 14.4 68 63.1",
  aspect: 68 / 63.1,
  m: "M16.01 75.25L16.09 75.83L16.31 76.38L16.67 76.84L17.14 77.2L17.68 77.42L18.26 77.5L27.26 77.5L27.84 77.42L28.39 77.2L28.85 76.84L29.21 76.38L29.43 75.83L29.51 75.25L29.51 60.06L29.59 59.47L29.83 58.91L30.2 58.44L30.69 58.09L31.25 57.87L31.85 57.82L32.44 57.92L32.99 58.18L34.96 59.37L36.45 60.14L37.77 60.74L39.22 61.32L40.81 61.86L42.32 62.28L43.73 62.6L45.38 62.9L46.93 63.09L48.38 63.2L50.06 63.24L51.62 63.2L53.07 63.09L54.73 62.88L56.27 62.6L57.68 62.28L59.19 61.86L60.67 61.36L62.23 60.74L63.55 60.14L64.94 59.43L67.01 58.18L67.56 57.92L68.15 57.82L68.75 57.87L69.31 58.09L69.8 58.44L70.17 58.91L70.41 59.47L70.49 60.06L70.49 75.25L70.57 75.83L70.79 76.38L71.15 76.84L71.61 77.2L72.16 77.42L72.74 77.5L81.74 77.5L82.32 77.42L82.86 77.2L83.33 76.84L83.69 76.38L83.91 75.83L83.99 75.25L83.99 24.75L83.91 24.17L83.69 23.62L83.33 23.16L82.86 22.8L82.32 22.58L81.74 22.5L74.15 22.5L73.61 22.56L73.1 22.76L72.66 23.06L72.3 23.47L72.05 23.94L66.13 39.27L65.38 40.75L64.87 41.61L63.91 42.96L63.34 43.65L62.12 44.93L60.77 46.07L59.22 47.14L57.66 47.99L56.03 48.68L54.33 49.2L52.71 49.53L51.83 49.64L50.06 49.74L48.29 49.65L46.53 49.39L44.71 48.93L43.05 48.31L41.45 47.53L40.69 47.08L39.32 46.14L37.96 45L36.66 43.65L36.09 42.96L35.13 41.61L34.62 40.75L33.87 39.27L27.95 23.94L27.7 23.47L27.34 23.06L26.9 22.76L26.39 22.56L25.85 22.5L18.26 22.5L17.68 22.58L17.14 22.8L16.67 23.16L16.31 23.62L16.09 24.17L16.01 24.75Z",
  ball: { cx: 50, cy: 32.07, r: 17.67 },
};

/** The master drawn at a height of `size` px: small sizes get a thicker stroke to stay crisp. */
export function markMaster(size: number): MarkMaster {
  if (size < 24) return MARK_MICRO;
  if (size < 48) return MARK_SMALL;
  return MARK_REGULAR;
}

/**
 * The app's mark, Weight: an M of rope bent by one ball (docs/brand). Only the ball has colour;
 * `mono` draws both in the text colour.
 */
export const MattersMark = (props: { size: number; mono?: boolean }) => {
  const master = () => markMaster(props.size);
  return (
    <svg
      width={Math.round(props.size * master().aspect)}
      height={props.size}
      viewBox={master().viewBox}
      aria-hidden="true"
    >
      <path d={master().m} fill={props.mono ? "currentColor" : "var(--mark-m)"} />
      <circle
        cx={master().ball.cx}
        cy={master().ball.cy}
        r={master().ball.r}
        fill={props.mono ? "currentColor" : "var(--mark-ball)"}
      />
    </svg>
  );
};

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
