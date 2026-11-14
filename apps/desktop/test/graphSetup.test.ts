// Setup says who runs the mail, and the person can say (ADR 0135, rules 3 to 5), and what the
// screens say about a Microsoft mailbox over Graph (ADR 0136, rules 11 and 13): the choices, the
// routes they lead to, the found line, the window tests' DNS table, the add request, and the
// sentences of a Graph account's row and status. The window itself is in e2e/graphSetup.e2e.ts.
import type { AccountInfo } from "@matters/contracts";
import type { Credential, DiscoveredServers, FoundProvider, SyncStatus } from "@matters/core";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it } from "vitest";
import { accountInfo } from "../src/backend/accounts.ts";
import { type BackendDeps, handle, type NewAccountInput } from "../src/backend/handler.ts";
import { testDiscovery } from "../src/backend/testSeams.ts";
import { renewingRefused } from "../src/backend/transports.ts";
import { BackendError } from "../src/renderer/client.ts";
import { explainFailure, failureEvidence, signInTrouble } from "../src/renderer/explain.ts";
import { signInAgainFailure } from "../src/renderer/newPassword.ts";
import { describeStatus, summarize } from "../src/renderer/status.ts";
import {
  choiceLabel,
  choicesFor,
  currentChoice,
  foundLine,
  routeFor,
} from "../src/renderer/whoRunsMail.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const endpoint = (host: string, auth: readonly ("password" | "oauth2")[] = ["password"]) => ({
  host,
  port: 993,
  security: "tls" as const,
  usernameTemplate: "%EMAILADDRESS%",
  auth,
});
const fastmail: DiscoveredServers = {
  source: "ispdb",
  displayName: "Fastmail",
  imap: endpoint("imap.fastmail.com"),
  smtp: { ...endpoint("smtp.fastmail.com"), port: 465 },
};
const office: DiscoveredServers = {
  source: "ispdb",
  displayName: "Microsoft",
  imap: endpoint("outlook.office365.com", ["password", "oauth2"]),
  smtp: { ...endpoint("smtp.office365.com"), port: 587, security: "starttls" },
};
const microsoftByMx: FoundProvider = { id: "microsoft", decides: true, by: "mx" };
const googleBySpf: FoundProvider = { id: "google", decides: false, by: "spf" };
const yes = () => true;

describe("the list under Not right? (ADR 0135, rule 3)", () => {
  it("offers the providers Matters can add by name, then Another mail server", () => {
    expect(choicesFor(undefined, yes)).toEqual(["microsoft", "google", "other"]);
    expect(choicesFor(undefined, yes).map(choiceLabel)).toEqual([
      "Microsoft 365 or Outlook.com",
      "Google",
      "Another mail server",
    ]);
  });

  it("puts a hint's provider first and decides nothing", () => {
    expect(choicesFor(googleBySpf, yes)).toEqual(["google", "microsoft", "other"]);
    // A sign that decides does not reorder: the provider is already taken.
    expect(choicesFor(microsoftByMx, yes)).toEqual(["microsoft", "google", "other"]);
  });

  it("leaves out a provider this build cannot add", () => {
    expect(choicesFor(undefined, (id) => id !== "microsoft")).toEqual(["google", "other"]);
  });
});

describe("where setup goes (ADR 0135, rules 3 to 5; ADR 0136, rule 13)", () => {
  it("adds a mailbox found as Microsoft over Graph, with the provider's name on the line", () => {
    const route = routeFor({ servers: null, provider: microsoftByMx }, undefined, true);
    expect(route).toEqual({ kind: "graph", provider: "microsoft", how: "found" });
    expect(foundLine(route, "firma.example", "")).toBe("Found Microsoft 365 for firma.example");
    expect(currentChoice(route)).toBe("microsoft");
  });

  it("takes Microsoft's own servers in the settings found as Microsoft too", () => {
    expect(routeFor({ servers: office }, undefined, true)).toEqual({
      kind: "graph",
      provider: "microsoft",
      how: "found",
    });
    // Without the Graph sign-in in this build the servers lead where they led before.
    expect(routeFor({ servers: office }, undefined, false)).toEqual({
      kind: "servers",
      servers: office,
    });
    expect(routeFor({ servers: null, provider: microsoftByMx }, undefined, false)).toEqual({
      kind: "microsoftBlocked",
    });
  });

  it("names a mail server of no known provider by its server", () => {
    const route = routeFor({ servers: fastmail }, undefined, true);
    expect(route).toEqual({ kind: "servers", servers: fastmail });
    expect(foundLine(route, "fastmail.example", "imap.fastmail.com")).toBe(
      "Found Fastmail: imap.fastmail.com",
    );
    expect(currentChoice(route)).toBe("other");
  });

  it("lets a hint decide nothing: the servers found still lead, or the list when there are none", () => {
    expect(routeFor({ servers: fastmail, provider: googleBySpf }, undefined, true)).toEqual({
      kind: "servers",
      servers: fastmail,
    });
    const route = routeFor({ servers: null, provider: googleBySpf }, undefined, true);
    expect(route).toEqual({ kind: "choose" });
    expect(currentChoice(route)).toBeUndefined();
    expect(foundLine(route, "firma.example", "")).toBeNull();
  });

  it("shows the list at once when lookup found nothing", () => {
    expect(routeFor({ servers: null }, undefined, true)).toEqual({ kind: "choose" });
  });

  it("lets the choice win over what was found (rule 4)", () => {
    // Found as Microsoft, chosen as Google: Google's servers from its own mail domain (rule 6).
    const google = routeFor({ servers: null, provider: microsoftByMx }, "google", true);
    expect(google).toEqual({
      kind: "providerServers",
      provider: "google",
      how: "chosen",
      settingsDomain: "gmail.com",
    });
    expect(foundLine(google, "firma.example", "imap.gmail.com")).toBe(
      "Using Google for firma.example",
    );
    // Nothing found, chosen as Microsoft: over Graph.
    expect(routeFor({ servers: null }, "microsoft", true)).toEqual({
      kind: "graph",
      provider: "microsoft",
      how: "chosen",
    });
  });

  it("opens the server fields for Another mail server, with what lookup found in them", () => {
    expect(routeFor({ servers: null }, "other", true)).toEqual({ kind: "other" });
    // A Microsoft mailbox typed in by server name stays on IMAP (ADR 0133 as it is).
    expect(routeFor({ servers: office, provider: microsoftByMx }, "other", true)).toEqual({
      kind: "servers",
      servers: office,
    });
    expect(currentChoice({ kind: "other" })).toBe("other");
  });
});

describe("the DNS table of window tests", () => {
  it("answers who runs the mail from the table and asks the network nothing", async () => {
    const discovery = testDiscovery(
      JSON.stringify({
        "firma.example": { mx: ["firma-example.mail.protection.outlook.com"] },
        "hint.example": { txt: ["v=spf1 include:_spf.google.com ~all"] },
        "gateway.example": { autodiscover: ["autodiscover.outlook.com"] },
      }),
    );
    if (!discovery) throw new Error("no discovery");
    expect(await discovery.discover("firma.example")).toEqual({
      servers: null,
      provider: { id: "microsoft", decides: true, by: "mx" },
    });
    expect(await discovery.discover("hint.example")).toEqual({
      servers: null,
      provider: { id: "google", decides: false, by: "spf" },
    });
    expect(await discovery.discover("gateway.example")).toEqual({
      servers: null,
      provider: { id: "microsoft", decides: true, by: "autodiscover" },
    });
    expect(await discovery.discover("nothing.example")).toEqual({ servers: null });
  });

  it("is not there without the variable, or with something that is not a table", () => {
    expect(testDiscovery(undefined)).toBeNull();
    expect(testDiscovery("")).toBeNull();
    expect(testDiscovery("not json")).toBeNull();
    expect(testDiscovery("[1]")).toBeNull();
  });
});

describe("adding over Graph, as the window asks (ADR 0136, rules 2, 3, 13)", () => {
  const signIn = "signin-0123456789abcdef0123456789abcdef";
  const info = (input: NewAccountInput): AccountInfo => ({
    id: "a",
    address: input.address,
    displayName: input.displayName,
    ...(input.transport === "graph" ? { transport: "graph" as const } : {}),
    host: "",
    port: 0,
    security: "tls",
    username: "",
    canSend: true,
    status: { state: "idle" },
  });
  function rig() {
    const added: NewAccountInput[] = [];
    const storage = createInMemoryStorage();
    const deps = {
      ...storage,
      accountStore: storage.accounts,
      renderer: new FakeComposeRenderer(),
      send: noSend,
      savedViews: { list: async () => [], recentSearches: async () => [] },
      viewWrites: noViewWrites,
      counts: noCounts,
      ...imageDeps,
      accounts: {
        discover: async () => ({ servers: null }),
        list: async () => [],
        add: async (input: NewAccountInput) => {
          added.push(input);
          return { account: info(input), folderCount: 3 };
        },
        remove: async () => false,
        syncNow: async () => false,
        changePassword: async () => null,
        signInAgain: async () => null,
      },
    } satisfies BackendDeps;
    return { added, call: (raw: object) => handle(deps, { requestId: "r", ...raw }) };
  }

  it("takes the address and a sign-in's handle, and no servers", async () => {
    const t = rig();
    const answer = await t.call({
      type: "addAccount",
      transport: "graph",
      address: "jan@firma.example",
      signIn,
    });
    expect(answer).toMatchObject({ type: "addAccount", ok: true, account: { transport: "graph" } });
    expect(t.added).toEqual([
      { transport: "graph", address: "jan@firma.example", displayName: "", signIn },
    ]);
  });

  it("refuses a password, servers, no sign-in, or another transport", async () => {
    const t = rig();
    const base = { type: "addAccount", transport: "graph", address: "j@f.example" };
    for (const raw of [
      { ...base, password: "pw" },
      { ...base, signIn, password: "pw" },
      { ...base, signIn, imap: { host: "h", port: 993, security: "tls", username: "u" } },
      { ...base, signIn: "not-a-handle" },
      { ...base, signIn, transport: "pop" },
    ]) {
      expect(await t.call(raw)).toMatchObject({ ok: false, code: "invalidRequest" });
    }
    expect(t.added).toEqual([]);
  });

  it("shows a Graph account with no servers", () => {
    const info = accountInfo(
      {
        id: "a",
        transport: "graph",
        address: "jan@firma.example",
        displayName: "Jan",
        createdAtMs: 1,
      },
      { state: "idle" },
    );
    expect(info).toMatchObject({ transport: "graph", host: "", port: 0, canSend: true });
  });
});

describe("the backend asks the vault again once for a refused token (ADR 0136, rule 11)", () => {
  it("renews a token the book marked, notes the renewed one, and leaves others alone", async () => {
    const calls: string[] = [];
    let token = "t1";
    const inner = {
      availability: async () => ({ available: true }) as const,
      get: async (_id: string, options?: { renew?: boolean }): Promise<Credential> => {
        calls.push(options?.renew ? "renew" : "get");
        if (options?.renew) token = "t2";
        return { kind: "oauth2", provider: "microsoftGraph", accessToken: token };
      },
      set: async () => {},
      delete: async () => {},
      move: async () => {},
    };
    const marked = new Set<string>();
    const retries: string[] = [];
    const vault = renewingRefused(inner, {
      wasRefused: (t) => marked.has(t),
      renewedAfterRefusal: (t) => void retries.push(t),
    });
    expect(await vault.get("a")).toMatchObject({ accessToken: "t1" });
    expect(calls).toEqual(["get"]);
    marked.add("t1");
    expect(await vault.get("a")).toMatchObject({ accessToken: "t2" });
    expect(calls).toEqual(["get", "get", "renew"]);
    expect(retries).toEqual(["t2"]);
    // The renewed token is not marked: handed out as it is.
    expect(await vault.get("a")).toMatchObject({ accessToken: "t2" });
    expect(calls).toEqual(["get", "get", "renew", "get"]);
  });

  it("passes a password through untouched", async () => {
    const vault = renewingRefused(
      {
        availability: async () => ({ available: true }) as const,
        get: async () => ({ kind: "password", username: "u", password: "p" }) as const,
        set: async () => {},
        delete: async () => {},
        move: async () => {},
      },
      { wasRefused: () => true, renewedAfterRefusal: () => {} },
    );
    expect(await vault.get("a")).toEqual({ kind: "password", username: "u", password: "p" });
  });
});

const refusedStatus = (refusal: "notAllowed" | "signInAgain" | "unavailable", text?: string) =>
  ({
    state: "error",
    kind: "auth",
    message: "refused",
    detail: { refusal, ...(text ? { serverText: text } : {}) },
  }) as SyncStatus;

describe("what a Graph account's row and status say (ADR 0136, rules 11 and 13)", () => {
  /** No sentence about a Graph account speaks of a password, of IMAP, or of a setting to turn on. */
  const clean = (text: string) => {
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/IMAP/);
    expect(text).not.toMatch(/turn (it )?on|switch(ed)? (it )?on/i);
  };

  it("says notAllowed as the organisation not letting this app read the mailbox, quoting Graph", () => {
    const why = signInTrouble(
      refusedStatus("notAllowed", "Access is denied. Check credentials and try again."),
      "",
      true,
      "graph",
    );
    expect(why).toEqual({
      sentence:
        "Microsoft won't let Matters read this mailbox: your organisation doesn't allow this app. Ask an administrator of your organisation to allow Matters, then choose Sync now.",
      evidence: "Microsoft said: “Access is denied. Check credentials and try again.”",
    });
    clean(why?.sentence ?? "");
    expect(describeStatus(refusedStatus("notAllowed"), true, true)).toEqual({
      tone: "error",
      text: "Not allowed by your organisation",
    });
  });

  it("says an ended sign-in without a password in it", () => {
    const why = signInTrouble(refusedStatus("signInAgain"), "", true, "graph");
    expect(why?.sentence).toBe(
      "The sign-in with Microsoft has ended: it was withdrawn, or it went unused for too long. Choose Sign in again.",
    );
    clean(why?.sentence ?? "");
    expect(describeStatus(refusedStatus("signInAgain"), true, true).text).toBe("Sign-in ended");
  });

  it("keeps every refusal and failure label free of servers, passwords and IMAP", () => {
    for (const refusal of [
      "credentials",
      "appPassword",
      "webLogin",
      "imapOff",
      "browserOnly",
      "signInAgain",
      "notAllowed",
      "expired",
      "encryptionRequired",
      "unavailable",
      "throttled",
      undefined,
    ] as const) {
      const status = {
        state: "error",
        kind: "auth",
        message: "",
        ...(refusal ? { detail: { refusal } } : {}),
      } as SyncStatus;
      clean(signInTrouble(status, "", true, "graph")?.sentence ?? "");
      clean(describeStatus(status, true, true).text);
    }
    for (const kind of ["unreachable", "credentials", "tls"] as const) {
      clean(describeStatus({ state: "error", kind, message: "" }, true, true).text);
    }
    expect(
      describeStatus({ state: "error", kind: "unreachable", message: "" }, true, true).text,
    ).toBe("Microsoft unreachable, retrying");
  });

  it("puts a Graph account's failure in the header in the same words", () => {
    const account = {
      id: "a",
      address: "jan@firma.example",
      displayName: "Jan",
      transport: "graph",
      host: "",
      port: 0,
      security: "tls",
      username: "",
      canSend: true,
      status: refusedStatus("notAllowed"),
    } as AccountInfo;
    expect(summarize([account], {})).toEqual({
      tone: "error",
      text: "Not allowed by your organisation",
    });
  });

  it("explains a failed add over Graph without a server, a password or IMAP", () => {
    const context = { host: "", port: 0, browserSignIn: true, transport: "graph" as const };
    for (const code of [
      "authFailed",
      "outgoingAuthFailed",
      "outgoingFailed",
      "tlsFailed",
      "unreachable",
      "internal",
    ] as const) {
      const text = explainFailure(new BackendError(code, "x", { refusal: "notAllowed" }), context);
      clean(text);
      expect(text).not.toContain(":0");
    }
    expect(explainFailure(new BackendError("unreachable", "x"), context)).toBe(
      "Could not reach Microsoft. Check your internet connection, then try again.",
    );
    expect(
      failureEvidence(
        new BackendError("authFailed", "x", { refusal: "notAllowed", serverText: "Denied." }),
        true,
      ),
    ).toBe("Microsoft said: “Denied.”");
    const again = signInAgainFailure(new BackendError("unreachable", "x"), {
      host: "",
      port: 0,
      transport: "graph",
    });
    expect(again).toBe(
      "Could not reach Microsoft. Check your internet connection, then try again. The saved sign-in is unchanged.",
    );
  });
});
