// Who runs the mail, in setup (ADR 0135, rules 3 to 5): what lookup found, what the person said
// under *Not right?*, and where that leads. Pure, so the choices are tested without a window.
import {
  browserSignInProvider,
  choosableProviders,
  type DiscoveredServers,
  type FoundProvider,
  type MailProviderId,
  mailProvider,
} from "@matters/core";

/** A provider of the list, or *Another mail server*. */
export type MailChoice = MailProviderId | "other";

/** How setup came to a provider: lookup showed it, or the person chose it. */
export type ProviderHow = "found" | "chosen";

/** What lookup answered (ADR 0135, rule 1), as setup keeps it. */
export interface LookedUp {
  readonly servers: DiscoveredServers | null;
  readonly provider?: FoundProvider;
}

/** Where setup goes from what was found and what was chosen. */
export type SetupRoute =
  /** A Microsoft mailbox over Graph: *Sign in with Microsoft*, no server fields (ADR 0136, rule 13). */
  | { readonly kind: "graph"; readonly provider: MailProviderId; readonly how: ProviderHow }
  /**
   * The provider's servers, from where lookup would have found them: ISPDB for its own mail
   * domain (rule 6). Setup asks lookup for `settingsDomain`.
   */
  | {
      readonly kind: "providerServers";
      readonly provider: MailProviderId;
      readonly how: ProviderHow;
      readonly settingsDomain: string;
    }
  /** The servers found, with the provider named when lookup showed it (rule 5). */
  | {
      readonly kind: "servers";
      readonly servers: DiscoveredServers;
      readonly named?: { readonly provider: MailProviderId; readonly how: ProviderHow };
    }
  /** *Another mail server*: the server fields, as before (rule 3). */
  | { readonly kind: "other" }
  /** Nothing found and nothing chosen: the list at once (rule 3). */
  | { readonly kind: "choose" }
  /** Microsoft was found, and this build cannot add it over Graph: the old screen says so. */
  | { readonly kind: "microsoftBlocked" };

/**
 * The list under *Not right?* (rule 3): the providers Matters can add by name, then *Another mail
 * server*. A hint (SPF alone) puts its provider first and decides nothing. A provider whose
 * sign-in this build does not offer is left out: it could not be added by name.
 */
export function choicesFor(
  found: FoundProvider | undefined,
  canAdd: (provider: MailProviderId) => boolean,
): readonly MailChoice[] {
  const providers = choosableProviders()
    .map((rule) => rule.id)
    .filter(canAdd);
  const hinted = found !== undefined && !found.decides ? found.id : undefined;
  const ordered =
    hinted !== undefined && providers.includes(hinted)
      ? [hinted, ...providers.filter((id) => id !== hinted)]
      : providers;
  return [...ordered, "other"];
}

/** How the list names a choice. */
export function choiceLabel(choice: MailChoice): string {
  return choice === "other" ? "Another mail server" : (mailProvider(choice)?.choice ?? choice);
}

/** The line under a choice: how that mailbox is reached and signed in to. */
export function choiceNote(choice: MailChoice): string {
  if (choice === "other") return "Enter the server names yourself.";
  return mailProvider(choice)?.transport === "graph"
    ? "Sign in with Microsoft in your browser. No server names needed."
    : "Its servers are filled in for you. Sign in with an app password.";
}

/**
 * Where setup goes (rules 3 and 4): the person's choice wins over what was found. Lookup decides
 * through the mail exchanger or autodiscover, or through servers that are Microsoft's own: a
 * Microsoft mailbox found either way is added over Graph when this build offers it (ADR 0136,
 * rule 13), so IMAP with a token is reached only through *Another mail server*. `graphOffered`:
 * this build has the Graph sign-in (ADR 0133, rule 4).
 */
export function routeFor(
  lookedUp: LookedUp,
  choice: MailChoice | undefined,
  graphOffered: boolean,
): SetupRoute {
  const found = lookedUp.provider;
  const servers = lookedUp.servers;
  // The server fields, holding what lookup found when it found servers (ADR 0133 as it is: a
  // Microsoft mailbox typed in by server name signs in to IMAP).
  const other: SetupRoute = servers ? { kind: "servers", servers } : { kind: "other" };
  if (choice === "other") return other;
  if (choice !== undefined) return providerRoute(choice, "chosen", graphOffered) ?? other;
  if (found?.decides) {
    const rule = mailProvider(found.id);
    if (rule?.transport === "graph") {
      if (graphOffered) return { kind: "graph", provider: found.id, how: "found" };
      return servers ? { kind: "servers", servers } : { kind: "microsoftBlocked" };
    }
    if (servers) return { kind: "servers", servers, named: { provider: found.id, how: "found" } };
    return providerRoute(found.id, "found", graphOffered) ?? { kind: "choose" };
  }
  if (servers) {
    // Microsoft's own servers in the settings found: a Microsoft mailbox in the cloud.
    if (graphOffered && browserSignInProvider(servers) === "microsoft") {
      return { kind: "graph", provider: "microsoft", how: "found" };
    }
    return { kind: "servers", servers };
  }
  return { kind: "choose" };
}

function providerRoute(
  id: MailProviderId,
  how: ProviderHow,
  graphOffered: boolean,
): SetupRoute | undefined {
  const rule = mailProvider(id);
  if (rule === undefined) return undefined;
  if (rule.transport === "graph") {
    return graphOffered ? { kind: "graph", provider: id, how } : undefined;
  }
  return rule.settingsDomain === undefined
    ? undefined
    : { kind: "providerServers", provider: id, how, settingsDomain: rule.settingsDomain };
}

/** The choice the list shows as taken for a route; none while nothing is chosen. */
export function currentChoice(route: SetupRoute): MailChoice | undefined {
  switch (route.kind) {
    case "graph":
    case "providerServers":
      return route.provider;
    case "servers":
      return route.named?.provider ?? "other";
    case "other":
      return "other";
    default:
      return undefined;
  }
}

/**
 * The line that says what was found (rule 5): the provider's name when one was found or chosen,
 * *Found Microsoft 365 for firma.pl*; the server name only for a mail server of no known
 * provider. Null when there is no line (nothing found).
 */
export function foundLine(route: SetupRoute, domain: string, host: string): string | null {
  const named =
    route.kind === "graph" || route.kind === "providerServers"
      ? { provider: route.provider, how: route.how }
      : route.kind === "servers"
        ? route.named
        : undefined;
  if (named !== undefined) {
    const name = mailProvider(named.provider)?.name ?? named.provider;
    return named.how === "found" ? `Found ${name} for ${domain}` : `Using ${name} for ${domain}`;
  }
  if (route.kind !== "servers") return null;
  const display = route.servers.displayName ?? "";
  return display === "" ? `Found ${host}` : `Found ${display}: ${host}`;
}
