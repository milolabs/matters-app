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

/**
 * Microsoft's own personal domains (outlook.com, hotmail.co.uk, ...): no organisation can claim
 * them, so an address there is a personal account. Any other address can be either: a personal
 * Microsoft account may use a Gmail address, and nothing the account records says which.
 */
const MICROSOFT_PERSONAL = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

/** Which of the provider's pages: main opens it by this name, never by an address from a page. */
export type PermissionPageId = "microsoftWork" | "microsoftPersonal";

export interface PermissionPage {
  readonly id: PermissionPageId;
  readonly provider: "Microsoft";
  /** Whose page it is, for when both are shown: "work or school accounts", "personal accounts". */
  readonly audience: string;
  readonly url: string;
}

/** Whose page each is, in the words the screens use. */
export const PERMISSION_PAGE_AUDIENCE: Readonly<Record<PermissionPageId, string>> = {
  microsoftWork: "work or school accounts",
  microsoftPersonal: "personal accounts",
};

const page = (id: PermissionPageId): PermissionPage => ({
  id,
  provider: "Microsoft",
  audience: PERMISSION_PAGE_AUDIENCE[id],
  url: permissionPageUrl(id),
});

/** The address of a page by its id, for main to open. */
export function permissionPageUrl(id: PermissionPageId): string {
  return id === "microsoftPersonal"
    ? MICROSOFT_PERMISSION_PAGES.personal
    : MICROSOFT_PERMISSION_PAGES.work;
}

export const isPermissionPageId = (v: unknown): v is PermissionPageId =>
  v === "microsoftWork" || v === "microsoftPersonal";

/**
 * The pages where the person takes back the app's permission; none when the account signs in with
 * a password (there is nothing to take back). An address on Microsoft's own personal domains gets
 * the personal page; for any other the kind of account is not known, so both are offered rather
 * than a guess.
 */
export function permissionPages(signIn: SignInKind, address: string): readonly PermissionPage[] {
  if (signIn !== "microsoft") return [];
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  if (MICROSOFT_PERSONAL.test(domain)) return [page("microsoftPersonal")];
  return [page("microsoftWork"), page("microsoftPersonal")];
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

/** The provider's pages for an account as the screens show them; none for a password account. */
export function accountPermissionPages(account: {
  readonly transport?: MailTransport;
  readonly host: string;
  readonly address: string;
}): readonly PermissionPage[] {
  return permissionPages(signInKind(account), account.address);
}
