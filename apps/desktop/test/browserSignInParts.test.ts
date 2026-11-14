// ADR 0133: the pieces around browser sign-in that are not the flow itself: main's argument
// checks, the client id, the stand-in browser of window tests, the preload bridge, and what the
// screens say.
import type { DiscoveredServers, SyncStatus } from "@matters/core";
import { startStandInAuthServer } from "@matters/testkit";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_ID_VARIABLE,
  clientIds,
  isLoopbackUrl,
  MICROSOFT_CLIENT_ID,
  parseSignInAsk,
  testBrowser,
} from "../src/main/browserSignIn.ts";
import { CHANNEL_SIGN_IN, createSignInBridge } from "../src/preload/signInBridge.ts";
import { BackendError } from "../src/renderer/client.ts";
import {
  explainFailure,
  passwordHint,
  refusalSentence,
  signInTrouble,
} from "../src/renderer/explain.ts";
import {
  passwordRejected,
  signInAgainFailure,
  signInAgainSaved,
  signInEnded,
} from "../src/renderer/newPassword.ts";
import {
  createBrowserSignIn,
  readAnswer,
  type SignInClient,
  setupStepFor,
  signInFailureEvidence,
  signInFailureSentence,
} from "../src/renderer/signIn.ts";
import { describeStatus } from "../src/renderer/status.ts";

describe("main's checks of a page's ask (ADR 0133)", () => {
  it("takes the three actions with their arguments, and nothing else", () => {
    expect(parseSignInAsk("offered", "microsoft", undefined)).toEqual({
      action: "offered",
      provider: "microsoft",
    });
    expect(parseSignInAsk("start", "microsoft", "  Me@Outlook.com ")).toEqual({
      action: "start",
      provider: "microsoft",
      address: "Me@Outlook.com",
    });
    expect(parseSignInAsk("cancel", undefined, undefined)).toEqual({ action: "cancel" });
    expect(parseSignInAsk("start", "google", "me@x.com")).toBeNull();
    expect(parseSignInAsk("start", "microsoft", "not an address")).toBeNull();
    expect(parseSignInAsk("start", "microsoft", 42)).toBeNull();
    expect(parseSignInAsk("start", "microsoft", `${"a".repeat(320)}@x.com`)).toBeNull();
    expect(parseSignInAsk("open", "microsoft", "me@x.com")).toBeNull();
    expect(parseSignInAsk("offered", { toString: () => "microsoft" }, undefined)).toBeNull();
  });

  it("reads the client id from the environment, else the one built in; the source has none (rule 4)", () => {
    expect(MICROSOFT_CLIENT_ID).toBe("");
    expect(clientIds({})).toEqual({});
    expect(clientIds({ [CLIENT_ID_VARIABLE]: "  " })).toEqual({});
    expect(clientIds({ [CLIENT_ID_VARIABLE]: " abc-123 " })).toEqual({
      microsoft: "abc-123",
      microsoftGraph: "abc-123",
    });
  });
});

describe("the stand-in browser of window tests (rule 13)", () => {
  it("is only for a loopback authority and the two modes", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1/x")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1/")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1/")).toBe(false);
    expect(isLoopbackUrl("http://login.microsoftonline.com/")).toBe(false);
    expect(testBrowser("follow", "https://login.microsoftonline.com/common")).toBeNull();
    expect(testBrowser("follow", "http://10.0.0.1/common")).toBeNull();
    expect(testBrowser("open", "http://127.0.0.1:9/common")).toBeNull();
    expect(testBrowser(undefined, "http://127.0.0.1:9/common")).toBeNull();
  });

  it("asks nothing in wait mode", async () => {
    const fetchFn = vi.fn();
    const open = testBrowser("wait", "http://127.0.0.1:9/common", fetchFn as never);
    await open?.("http://127.0.0.1:9/common/oauth2/v2.0/authorize");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("follows only the stand-in's page and a redirect to this machine", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(url);
      const location = url.includes("authorize")
        ? url.includes("evil")
          ? "https://example.com/steal"
          : "http://localhost:5555/?code=c&state=s"
        : null;
      return new Response("", {
        status: location ? 302 : 200,
        headers: location ? { location } : {},
      });
    }) as typeof fetch;
    const open = testBrowser("follow", "http://127.0.0.1:9/common", fetchFn);
    if (!open) throw new Error("no stand-in browser");
    await expect(open("https://login.microsoftonline.com/common/authorize")).rejects.toThrow();
    await expect(open("http://127.0.0.1:10/common/authorize")).rejects.toThrow();
    expect(asked).toEqual([]);
    await open("http://127.0.0.1:9/common/oauth2/v2.0/authorize");
    await open("http://127.0.0.1:9/common/oauth2/v2.0/authorize?evil=1");
    expect(asked).toEqual([
      "http://127.0.0.1:9/common/oauth2/v2.0/authorize",
      "http://localhost:5555/?code=c&state=s",
      "http://127.0.0.1:9/common/oauth2/v2.0/authorize?evil=1",
    ]);
  });

  it("signs in against the stand-in server like a browser would", async () => {
    const auth = await startStandInAuthServer();
    try {
      const { BrowserOAuth } = await import("@matters/adapter-oauth");
      const open = testBrowser("follow", auth.authority);
      if (!open) throw new Error("no stand-in browser");
      const oauth = new BrowserOAuth({
        clientIds: { microsoft: auth.clientId },
        authority: auth.authority,
        openBrowser: open,
      });
      const result = await oauth.signIn({ provider: "microsoft", address: "me@outlook.example" });
      expect(result).toMatchObject({ ok: true, address: "me@outlook.example" });
    } finally {
      await auth.stop();
    }
  });
});

describe("the preload's sign-in bridge", () => {
  const page = {};
  function bridge(answer: unknown = { ok: true, handle: "h", address: "a" }) {
    const invoked: unknown[][] = [];
    const posted: unknown[] = [];
    const b = createSignInBridge(
      {
        invoke: async (...args) => {
          invoked.push(args);
          return answer;
        },
        post: (m) => posted.push(m),
      },
      page,
    );
    return { b, invoked, posted };
  }

  it("passes a well-formed ask to main and its answer back", async () => {
    const t = bridge();
    t.b.message({
      source: page,
      data: {
        mattersSignIn: {
          requestId: "s1",
          action: "start",
          provider: "microsoft",
          address: "me@x.com",
        },
      },
    });
    await vi.waitFor(() => expect(t.posted).toHaveLength(1));
    expect(t.invoked).toEqual([[CHANNEL_SIGN_IN, "start", "microsoft", "me@x.com"]]);
    expect(t.posted).toEqual([
      { mattersSignInAnswer: { requestId: "s1", answer: { ok: true, handle: "h", address: "a" } } },
    ]);
  });

  it("refuses other shapes and other windows without asking main", async () => {
    const t = bridge();
    t.b.message({ source: {}, data: { mattersSignIn: { requestId: "s1", action: "start" } } });
    t.b.message({ source: page, data: { mattersSignIn: { requestId: "s2", action: "steal" } } });
    t.b.message({
      source: page,
      data: { mattersSignIn: { requestId: "s3", action: "start", address: { x: 1 } } },
    });
    t.b.message({ source: page, data: { mattersSignIn: { requestId: 7, action: "cancel" } } });
    await Promise.resolve();
    expect(t.invoked).toEqual([]);
    expect(t.posted).toEqual([
      { mattersSignInAnswer: { requestId: "s2", answer: null } },
      { mattersSignInAnswer: { requestId: "s3", answer: null } },
    ]);
  });
});

describe("what the page makes of main's answer", () => {
  it("keeps a handle and an address, and only the known reasons", () => {
    expect(readAnswer({ ok: true, handle: "h", address: "a", accessToken: "x" })).toEqual({
      ok: true,
      handle: "h",
      address: "a",
    });
    expect(readAnswer(null)).toEqual({ ok: false, reason: "failed" });
    expect(readAnswer({ ok: true, handle: 1 })).toEqual({ ok: false, reason: "failed" });
    expect(readAnswer({ ok: false, reason: "notFinished" })).toEqual({
      ok: false,
      reason: "notFinished",
    });
    expect(
      readAnswer({ ok: false, reason: "wrongAccount", signedIn: "b@x", asked: "a@x" }),
    ).toEqual({ ok: false, reason: "wrongAccount", signedIn: "b@x", asked: "a@x" });
    expect(readAnswer({ ok: false, reason: "adminApproval", providerText: "AADSTS65001" })).toEqual(
      {
        ok: false,
        reason: "adminApproval",
        providerText: "AADSTS65001",
      },
    );
    expect(readAnswer({ ok: false, reason: "whatever" })).toEqual({ ok: false, reason: "failed" });
  });
});

describe("what the screens say about a sign-in that gave nothing (rule 12)", () => {
  it.each([
    [
      { ok: false, reason: "notFinished" },
      "The sign-in was not finished. Try again when you're ready.",
    ],
    [
      {
        ok: false,
        reason: "adminApproval",
        providerText: "AADSTS65001: The user has not consented.",
      },
      "Your organisation has to approve Matters before you can sign in. Ask an administrator of your organisation to approve it, then try again.",
    ],
    [
      { ok: false, reason: "wrongAccount", signedIn: "jan@contoso.com", asked: "me@outlook.com" },
      "You signed in as jan@contoso.com, not me@outlook.com. Nothing was saved. Try again and choose me@outlook.com.",
    ],
    [
      { ok: false, reason: "unreachable" },
      "Microsoft couldn't be reached to finish the sign-in. Check your internet connection, then try again.",
    ],
    [
      { ok: false, reason: "notOffered" },
      "Sign-in with Microsoft isn't set up in this copy of Matters.",
    ],
    [{ ok: false, reason: "failed" }, "Microsoft didn't finish the sign-in. Try again."],
  ] as const)("%o", (failure, text) => {
    expect(signInFailureSentence(failure, "microsoft")).toBe(text);
  });

  it("quotes Microsoft under the sentence when it said something", () => {
    expect(
      signInFailureEvidence(
        { ok: false, reason: "adminApproval", providerText: "Need admin" },
        "microsoft",
      ),
    ).toBe("Microsoft said: “Need admin”");
    expect(
      signInFailureEvidence({ ok: false, reason: "notFinished" }, "microsoft"),
    ).toBeUndefined();
  });
});

describe("which step setup goes to (rule 11)", () => {
  const endpoint = (host: string, port: number) => ({
    host,
    port,
    security: "tls" as const,
    usernameTemplate: "%EMAILADDRESS%",
    auth: ["password" as const],
  });
  const microsoft: DiscoveredServers = {
    source: "ispdb",
    imap: endpoint("outlook.office365.com", 993),
    smtp: endpoint("smtp.office365.com", 587),
  };
  const plain: DiscoveredServers = {
    source: "ispdb",
    imap: endpoint("imap.example.com", 993),
    smtp: endpoint("smtp.example.com", 465),
  };

  it("signs in on Microsoft's servers when offered, and is blocked as before when not", () => {
    expect(setupStepFor(microsoft, () => true)).toBe("browser");
    expect(setupStepFor(microsoft, () => false)).toBe("blocked");
    expect(setupStepFor(plain, () => true)).toBe("password");
  });
});

describe("the sentences about Microsoft's servers, offered or not", () => {
  const host = "outlook.office365.com";
  it("keeps today's words when browser sign-in is not offered", () => {
    expect(refusalSentence("browserOnly", host, "setup", false)).toBe(
      "Microsoft takes only browser sign-in from mail apps, which Matters can't do yet. A password won't work there.",
    );
    expect(passwordHint(host)).toBe(
      "Microsoft takes only browser sign-in from mail apps, which Matters can't do yet. A password won't work there.",
    );
  });

  it("does not say Matters can't do it when it can", () => {
    expect(refusalSentence("browserOnly", host, "setup", true)).toBe(
      "Microsoft takes only browser sign-in from mail apps, so a password won't work there. Choose Sign in with Microsoft instead.",
    );
    expect(refusalSentence("browserOnly", host, "status", true)).toBe(
      "Microsoft takes only browser sign-in from mail apps, so a password won't work there. Choose Sign in again instead.",
    );
    expect(refusalSentence("browserOnly", "imap.x.pl", "setup", true)).toBe(
      "This server takes only browser sign-in from mail apps. Matters can do that only on Microsoft's own servers, so a password won't work here.",
    );
    expect(passwordHint(host, true)).toBe(
      "Microsoft takes only browser sign-in from mail apps, so a password won't work there.",
    );
    expect(
      explainFailure(new BackendError("outgoingAuthFailed", "x", { refusal: "browserOnly" }), {
        host: "imap.x.pl",
        port: 993,
        smtpHost: "smtp.x.pl",
        browserSignIn: true,
      }),
    ).not.toMatch(/can't do yet/);
  });

  it("says an ended sign-in, and IMAP switched off, in Microsoft's terms", () => {
    expect(refusalSentence("signInAgain", host, "status")).toBe(
      "The sign-in with Microsoft has ended: it was withdrawn, the password was changed, or it went unused for too long. Choose Sign in again.",
    );
    expect(refusalSentence("signInAgain", host, "setup")).toBe(
      "The sign-in with Microsoft ended before the account was saved. Sign in again.",
    );
    expect(refusalSentence("signInAgain", host, "newPassword")).toBe(
      "The sign-in with Microsoft ended before it was saved. Try again.",
    );
    const where =
      "On Outlook.com, open Settings, then Mail, then Forwarding and IMAP, and turn on “Let devices and apps use IMAP”. For a work or school mailbox, whoever runs the organisation's mail turns it on. If it's already on, Microsoft can take a while to let apps in: try again later.";
    expect(refusalSentence("notAllowed", host, "status")).toBe(
      `Microsoft won't let mail apps into this mailbox until IMAP is on. ${where}`,
    );
    expect(refusalSentence("notAllowed", host, "setup")).toBe(
      `Microsoft won't let mail apps into this mailbox until IMAP is on. ${where}`,
    );
    // A refusal that names no reason says where IMAP is switched on too, and no password: the
    // sign-in there is a token (rule 10).
    expect(refusalSentence(undefined, host, "setup")).toBe(
      `Microsoft's mail server refused the sign-in and didn't say why. Most often IMAP is off for the mailbox. ${where}`,
    );
    for (const place of ["setup", "newPassword", "status"] as const) {
      for (const refusal of [
        undefined,
        "unknown",
        "credentials",
        "appPassword",
        "expired",
        "notAllowed",
        "unavailable",
        "encryptionRequired",
        "throttled",
        "webLogin",
        "imapOff",
      ] as const) {
        expect(refusalSentence(refusal, host, place, true)).not.toMatch(/password/i);
      }
    }
    // The few words in the account's row and the header follow.
    const refused = { state: "error", kind: "auth", message: "" } as const;
    expect(describeStatus(refused, true).text).toBe("Sign-in refused");
    expect(describeStatus(refused).text).toBe("Password rejected");
    expect(describeStatus({ ...refused, detail: { refusal: "notAllowed" } }, true).text).toBe(
      "IMAP is turned off",
    );
    expect(describeStatus({ state: "error", kind: "credentials", message: "" }, true).text).toBe(
      "Sign-in unavailable",
    );
    // Elsewhere notAllowed keeps its words.
    expect(refusalSentence("notAllowed", "imap.x.pl", "status")).toMatch(/^The server knows you/);
    expect(
      explainFailure(new BackendError("outgoingAuthFailed", "x", { refusal: "notAllowed" }), {
        host,
        port: 993,
        smtpHost: "smtp.office365.com",
      }),
    ).toBe(
      "Receiving works, but sending from mail apps is switched off for this mailbox or for your organisation. Whoever runs your organisation's mail can switch it on. Or add the account without sending for now.",
    );
  });
});

describe("an ended sign-in in its account's row", () => {
  const ended: SyncStatus = {
    state: "error",
    kind: "auth",
    message: "",
    detail: { refusal: "signInAgain" },
  };

  it("opens Sign in again, not the password form", () => {
    expect(signInEnded(ended)).toBe(true);
    expect(passwordRejected(ended)).toBe(false);
    expect(describeStatus(ended)).toEqual({ tone: "error", text: "Sign-in ended" });
    expect(signInTrouble(ended, "outlook.office365.com", true)?.sentence).toMatch(
      /^The sign-in with Microsoft has ended/,
    );
    expect(signInEnded({ ...ended, detail: { refusal: "credentials" } })).toBe(false);
  });

  it("says what was saved, and that a failure kept the saved sign-in", () => {
    expect(signInAgainSaved({ outgoing: "verified" })).toBe("Signed in. Syncing again.");
    expect(signInAgainSaved({ outgoing: "unchecked", outgoingNote: "timed out" })).toBe(
      "Signed in. Syncing again. The outgoing server could not be asked (timed out); the first send will tell.",
    );
    const account = { host: "outlook.office365.com", port: 993 };
    expect(
      signInAgainFailure(new BackendError("authFailed", "x", { refusal: "notAllowed" }), account),
    ).toMatch(
      /^Microsoft won't let mail apps into this mailbox .*The saved sign-in is unchanged\.$/,
    );
    expect(signInAgainFailure(new BackendError("outgoingAuthFailed", "x"), account)).toBe(
      "Receiving works with this sign-in, but the outgoing server refused it, so sending wouldn't. The saved sign-in is unchanged.",
    );
    expect(signInAgainFailure(new Error("x"), account)).toBe(
      "Something went wrong. The saved sign-in is unchanged.",
    );
  });
});

describe("one sign-in on a screen", () => {
  function client(answers: Parameters<typeof readAnswer>[0][]) {
    const cancels: number[] = [];
    let release: (() => void) | null = null;
    const c: SignInClient = {
      offered: async () => true,
      start: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return readAnswer(answers.shift() ?? null);
      },
      cancel: async () => {
        cancels.push(1);
        release?.();
      },
    };
    return { c, cancels, finish: () => release?.() };
  }

  it("waits in the browser, then checks the servers with the handle", async () => {
    const t = client([{ ok: true, handle: "signin-x", address: "me@x.com" }]);
    await createRoot(async (dispose) => {
      const flow = createBrowserSignIn(t.c);
      const used: string[] = [];
      const run = flow.run(
        "microsoft",
        "me@x.com",
        async (h) => {
          expect(flow.phase()).toBe("checking");
          used.push(h);
        },
        () => ({ sentence: "no" }),
      );
      expect(flow.phase()).toBe("browser");
      t.finish();
      expect(await run).toBe(true);
      expect(used).toEqual(["signin-x"]);
      expect(flow.phase()).toBe("idle");
      dispose();
    });
  });

  it("says nothing when the person cancelled, and says why when the sign-in failed", async () => {
    const t = client([
      { ok: false, reason: "notFinished" },
      { ok: false, reason: "adminApproval", providerText: "AADSTS90094" },
    ]);
    await createRoot(async (dispose) => {
      const flow = createBrowserSignIn(t.c);
      const use = vi.fn(async () => {});
      const first = flow.run("microsoft", "me@x.com", use, () => ({ sentence: "" }));
      flow.cancel();
      expect(await first).toBe(false);
      expect(t.cancels).toHaveLength(1);
      expect(flow.failure()).toBe("");
      const second = flow.run("microsoft", "me@x.com", use, () => ({ sentence: "" }));
      t.finish();
      expect(await second).toBe(false);
      expect(flow.failure()).toMatch(/^Your organisation has to approve Matters/);
      expect(flow.evidence()).toBe("Microsoft said: “AADSTS90094”");
      expect(use).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("says the backend's failure in the screen's own words", async () => {
    const t = client([{ ok: true, handle: "signin-x", address: "me@x.com" }]);
    await createRoot(async (dispose) => {
      const flow = createBrowserSignIn(t.c);
      const run = flow.run(
        "microsoft",
        "me@x.com",
        async () => {
          throw new BackendError("authFailed", "x");
        },
        () => ({ sentence: "Refused.", evidence: "The server said: “no”" }),
      );
      t.finish();
      expect(await run).toBe(false);
      expect(flow.failure()).toBe("Refused.");
      expect(flow.evidence()).toBe("The server said: “no”");
      dispose();
    });
  });
});
