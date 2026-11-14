// Where a person takes back the permission an account's provider gave Matters (ADR 0138, rule 8).
// Matters throws its own sign-in away; the provider keeps listing the app as allowed until the
// person takes that back on the provider's page. A password account grants no such permission.

import type { MailTransport } from "./accounts.ts";
import { browserSignInProvider } from "./hosts.ts";

/**
 * Microsoft's pages, read on 2026-11-14.
 *
 * - `work`: Microsoft's support article "Edit or revoke application permissions in the My Apps
 *   portal" names https://myapplications.microsoft.com/ (verified on Microsoft's own page).
 * - `personal`: NOT VERIFIED on a page of Microsoft's own. Community and third-party guides name
 *   https://account.live.com/consent/Manage for personal Microsoft accounts; no Microsoft support
 *   article that names it was found. Check it before relying on it.
 */
export const MICROSOFT_PERMISSION_PAGES = {
  readAt: "2026-11-14",
  work: "https://myapplications.microsoft.com/",
  personal: "https://account.live.com/consent/Manage",
  personalVerified: false,
} as const;

/** How an account signs in: with a password, or through a provider that granted the app access. */
export type SignInKind = "password" | "microsoft";

/** Microsoft's personal domains (outlook.com, hotmail.co.uk, ...); any other is work or school. */
const MICROSOFT_PERSONAL = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

/** Which of the provider's pages: main opens it by this name, never by an address from a page. */
export type PermissionPageId = "microsoftWork" | "microsoftPersonal";

export interface PermissionPage {
  readonly id: PermissionPageId;
  readonly provider: "Microsoft";
  readonly url: string;
}

/** The address of a page by its id, for main to open. */
export function permissionPageUrl(id: PermissionPageId): string {
  return id === "microsoftPersonal"
    ? MICROSOFT_PERMISSION_PAGES.personal
    : MICROSOFT_PERMISSION_PAGES.work;
}

export const isPermissionPageId = (v: unknown): v is PermissionPageId =>
  v === "microsoftWork" || v === "microsoftPersonal";

/**
 * The page where the person takes back the app's permission, or null when the account signs in
 * with a password (there is nothing to take back).
 */
export function permissionPage(signIn: SignInKind, address: string): PermissionPage | null {
  if (signIn !== "microsoft") return null;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const personal = MICROSOFT_PERSONAL.test(domain);
  const id: PermissionPageId = personal ? "microsoftPersonal" : "microsoftWork";
  return { id, provider: "Microsoft", url: permissionPageUrl(id) };
}

/**
 * How an account signs in, read from what the account already records: its transport and its
 * server (ADR 0133, rule 11; ADR 0136, rule 3). Every browser sign-in Matters knows is Microsoft's.
 */
export function signInKind(account: {
  readonly transport?: MailTransport;
  readonly host: string;
}): SignInKind {
  return browserSignInProvider({ transport: account.transport, imap: { host: account.host } }) ===
    undefined
    ? "password"
    : "microsoft";
}

/** The provider's page for an account as the screens show it, or null for a password account. */
export function accountPermissionPage(account: {
  readonly transport?: MailTransport;
  readonly host: string;
  readonly address: string;
}): PermissionPage | null {
  return permissionPage(signInKind(account), account.address);
}
