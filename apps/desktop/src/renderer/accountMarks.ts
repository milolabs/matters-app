import type { QueryNode } from "@matters/core";

/**
 * The palette: muted, distinct in lightness as well as hue. `fill` sits under white letters
 * (footer avatars, swatches) and passes 4.5:1; the small dot uses the theme-aware
 * `--acct-<id>` variable from styles.css instead, which passes 3:1 on either background.
 */
export const ACCOUNT_COLORS = [
  { id: "blue", fill: "#3a5ba0" },
  { id: "ochre", fill: "#8a6d3b" },
  { id: "green", fill: "#2f6f5e" },
  { id: "plum", fill: "#8b4a6b" },
  { id: "indigo", fill: "#5b5b9a" },
  { id: "rust", fill: "#a0522d" },
  { id: "teal", fill: "#2f7a8a" },
  { id: "graphite", fill: "#6b6b70" },
] as const;

export type AccountColorId = (typeof ACCOUNT_COLORS)[number]["id"];

/** A palette id (a default, or a value persisted earlier) or a chosen `#rrggbb`. */
export type AccountColor = AccountColorId | `#${string}`;

const isColorId = (value: unknown): value is AccountColorId =>
  ACCOUNT_COLORS.some((c) => c.id === value);

export const isAccountColor = (value: unknown): value is AccountColor =>
  isColorId(value) || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));

/** Lower-cases a hex colour; a palette id stays as it is. */
export const normalizeAccountColor = (color: AccountColor): AccountColor =>
  color.startsWith("#") ? (color.toLowerCase() as AccountColor) : color;

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const LIGHT_INK = "#ffffff";
const DARK_INK = "#1d1d1f";

/** The letter colour on `fill`: white when it has 4.5:1 there, else the dark ink. */
export const inkOn = (fill: string): string =>
  contrastRatio(LIGHT_INK, fill) >= 4.5 ? LIGHT_INK : DARK_INK;

/** What identifies an account in the list, the footer and the reader (ADR 0032, 0033). */
export interface AccountMark {
  readonly letter: string;
  readonly color: AccountColor;
  /** Behind the footer letter: `#rrggbb`. */
  readonly fill: string;
  /** The letter's colour on `fill`. */
  readonly ink: string;
  /** For the small dot: a theme-aware CSS variable for a palette colour, else the hex itself. */
  readonly dot: string;
  readonly address: string;
}

type AccountRef = { id: string; address: string };

const upperFirst = (text: string): string => (text.trim()[0] ?? "?").toLocaleUpperCase();
const firstLetter = (text: string): string | undefined =>
  text.trim() === "" ? undefined : upperFirst(text);

function parts(address: string): { local: string; domain: string } {
  const at = address.lastIndexOf("@");
  return at < 0
    ? { local: address, domain: "" }
    : { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * A colour per account, as an id to colour record. A chosen palette colour is kept and reserved, a chosen hex is kept and reserves nothing; the others get, in
 * list order, the first palette colour no chosen or earlier account has, and wrap by index once
 * all are taken. The store persists the result, so a default sticks.
 */
export function resolveColors(
  accounts: readonly AccountRef[],
  chosen: Readonly<Record<string, AccountColor>>,
): Record<string, AccountColor> {
  const result: Record<string, AccountColor> = {};
  const used = new Set<AccountColorId>();
  for (const a of accounts) {
    const own = chosen[a.id];
    if (isAccountColor(own)) {
      const color = normalizeAccountColor(own);
      result[a.id] = color;
      if (isColorId(color)) used.add(color);
    }
  }
  accounts.forEach((a, i) => {
    if (result[a.id] !== undefined) return;
    const free = ACCOUNT_COLORS.find((c) => !used.has(c.id));
    const color = free ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0];
    result[a.id] = color.id;
    used.add(color.id);
  });
  return result;
}

/**
 * The mark per account: a colour (chosen, else the first free one) and a letter for the footer.
 * The letter is the domain's, or the local part's when two accounts would share it.
 */
export function accountMarks(
  accounts: readonly AccountRef[],
  chosen: Readonly<Record<string, AccountColor>>,
): ReadonlyMap<string, AccountMark> {
  const colors = resolveColors(accounts, chosen);
  const domainLetters = accounts.map((a) => firstLetter(parts(a.address).domain));
  const marks = new Map<string, AccountMark>();
  accounts.forEach((a, i) => {
    const domainLetter = domainLetters[i];
    // A missing domain also falls back to the local part; "?" only when both are empty.
    const sharedLetter =
      domainLetter === undefined || domainLetters.filter((l) => l === domainLetter).length > 1;
    const color = colors[a.id] ?? ACCOUNT_COLORS[0].id;
    const fill = isColorId(color)
      ? (ACCOUNT_COLORS.find((c) => c.id === color)?.fill ?? ACCOUNT_COLORS[0].fill)
      : color;
    marks.set(a.id, {
      letter: sharedLetter ? upperFirst(parts(a.address).local) : (domainLetter ?? "?"),
      color,
      fill,
      ink: inkOn(fill),
      dot: isColorId(color) ? `var(--acct-${color})` : color,
      address: a.address,
    });
  });
  return marks;
}

function pinsOneAccount(node: QueryNode | null): boolean {
  if (node === null) return false;
  if (node.kind === "account") return node.ids.length === 1;
  if (node.kind === "and") return node.children.some(pinsOneAccount);
  return false;
}

/** Whether rows carry a mark: the view mixes accounts. Depends on the query, never on results. */
export function showsAccountMarks(accountCount: number, root: QueryNode | null): boolean {
  return accountCount > 1 && !pinsOneAccount(root);
}
