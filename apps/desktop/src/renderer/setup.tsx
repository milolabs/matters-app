import type { AccountInfo } from "@matters/contracts";
import {
  type AgentStatus,
  browserSignInProvider,
  type DiscoveredServers,
  domainOfAddress,
  type MailProviderId,
  mailProvider,
  needsBrowserSignIn,
  type OAuthProvider,
  suggestedSmtpUsername,
  suggestedUsername,
  type TransportSecurity,
} from "@matters/core";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import { readDeclined, writeDeclined } from "./agentPrefs.ts";
import { ReadStep, RuntimeStep } from "./agentSetup.tsx";
import type { Backend } from "./client.ts";
import { explainFailure, type FailureContext, failureEvidence, passwordHint } from "./explain.ts";
import { MattersMark, markMaster, Ring } from "./icons.tsx";
import {
  createBrowserSignIn,
  mainSignIn,
  providerName,
  type SignInClient,
  type SignInPhase,
  setupStepFor,
} from "./signIn.ts";
import { describeStatus } from "./status.ts";
import { field, pill, pillPrimary } from "./ui.ts";
import {
  choiceLabel,
  choiceNote,
  choicesFor,
  currentChoice,
  foundLine,
  type LookedUp,
  type MailChoice,
  routeFor,
  type SetupRoute,
} from "./whoRunsMail.ts";

type Step = "address" | "finding" | "password" | "blocked" | "done" | "runtime" | "read";

const label = "mb-1 block text-[12px] text-secondary";
const bigInput =
  "selectable h-12 w-full border-0 border-b-[1.5px] border-edge bg-transparent font-serif text-[22px] outline-none placeholder:text-edge focus:border-ink";
const textButton = "cursor-default text-[12.5px] text-mid underline-offset-2 hover:underline";

/**
 * Connecting a mailbox, one question at a time: the address, then the password; the servers come
 * from a lookup (ADR 0023) and are shown to correct. What is answered stays on the page as a line
 * of the conversation and can be changed. With `onFinished` this is the first thing a new user
 * sees and ends on a success screen; without it, it is the form inside the Accounts dialog.
 *
 * On servers that take only a browser sign-in (ADR 0133, rule 11), when this build offers it,
 * the password field gives way to *Sign in with Microsoft*: the browser opens, setup waits with
 * *Cancel*, and the handle that comes back is tested and saved as a password would be.
 *
 * Lookup also says who runs the mail (ADR 0135): the line names the provider, and *Not right?*
 * opens a short list of providers and *Another mail server* in place of the server fields; when
 * nothing was found the list is there at once. A Microsoft mailbox, found or chosen, is added over
 * Microsoft Graph with no server fields (ADR 0136, rule 13). The choice holds until the address
 * changes and wins over what was found.
 */
export function Setup(props: {
  backend: Backend;
  onAdded: (account: AccountInfo) => void;
  onCancel?: () => void;
  accounts?: AccountsStore;
  onFinished?: () => void;
  /** AI was turned on or its status changed here: the window outside is told. */
  onAgentStatus?: (status: AgentStatus) => void;
  /** Main's browser sign-in; tests pass their own. */
  signIn?: SignInClient;
}) {
  const firstRun = () => props.onFinished !== undefined;
  const signInClient = props.signIn ?? mainSignIn;
  // The providers this build offers browser sign-in for (rule 4), asked of main once.
  const [offered, setOffered] = createSignal<ReadonlySet<OAuthProvider>>(new Set());
  // Both Microsoft entries are one registration, but each is asked for (ADR 0136, rule 3).
  const offeredReady = Promise.all(
    (["microsoft", "microsoftGraph"] as const).map((p) =>
      signInClient.offered(p).then(
        (yes) => (yes ? [p] : []),
        () => [],
      ),
    ),
  ).then((answers) => setOffered(new Set<OAuthProvider>(answers.flat())));
  onMount(() => void offeredReady);
  const browserSignIn = createBrowserSignIn(signInClient);
  onCleanup(() => browserSignIn.cancel());
  const [step, setStep] = createSignal<Step>("address");
  const [address, setAddress] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [revealed, setRevealed] = createSignal(false);
  const [yourName, setYourName] = createSignal("");
  const [found, setFound] = createSignal(false);
  // What lookup answered, and where it and the person's choice lead (ADR 0135, rules 3 to 5).
  const [lookedUp, setLookedUp] = createSignal<LookedUp>({ servers: null });
  const [route, setRoute] = createSignal<SetupRoute>({ kind: "choose" });
  // The person's answer under *Not right?*, for the address it was given for (rule 4).
  const [chosen, setChosen] = createSignal<{ address: string; choice: MailChoice } | null>(null);
  const [listOpen, setListOpen] = createSignal(false);
  // A provider's servers being looked up after it was chosen (rule 6).
  const [lookingUp, setLookingUp] = createSignal<MailProviderId | null>(null);
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal("993");
  const [security, setSecurity] = createSignal<TransportSecurity>("tls");
  const [username, setUsername] = createSignal("");
  // Outgoing server (ADR 0020); it shares the password with IMAP, and the user name while its own is empty.
  const [smtpHost, setSmtpHost] = createSignal("");
  const [smtpUsername, setSmtpUsername] = createSignal("");
  const [smtpPort, setSmtpPort] = createSignal("465");
  const [smtpSecurity, setSmtpSecurity] = createSignal<TransportSecurity>("tls");
  const [checking, setChecking] = createSignal(false);
  const [error, setError] = createSignal("");
  // The server's own words or the raw error, under the sentence (ADR 0114).
  const [evidence, setEvidence] = createSignal("");
  // The servers found are Microsoft's, which take no password over IMAP (ADR 0114).
  const [microsoft, setMicrosoft] = createSignal(false);
  const [outgoingFailed, setOutgoingFailed] = createSignal(false);
  const [added, setAdded] = createSignal<{
    account: AccountInfo;
    folderCount: number;
    smtpHost: string;
    /** Added with a browser sign-in, not a password (ADR 0133). */
    signedIn: boolean;
    /** Added over Microsoft Graph (ADR 0136): no servers to name. */
    graph: boolean;
  } | null>(null);
  // Every account added in this run, for the question about reading them (first run only).
  const [everyAdded, setEveryAdded] = createSignal<readonly AccountInfo[]>([]);
  const [agent, setAgent] = createSignal<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = createSignal(false);

  // The password is held in this component only; it is dropped when the screen goes away.
  onCleanup(() => setPassword(""));

  const domain = () => domainOfAddress(address().trim());
  /** The mailbox is added over Graph: found or chosen as Microsoft (ADR 0136, rule 13). */
  const graph = () => route().kind === "graph";
  // Whose browser sign-in the servers as they now stand take, when this build offers it: the
  // password field gives way to it (rule 11). Servers changed by hand are read the same way. Over
  // Graph it is Graph's entry, and there are no servers.
  const provider = (): OAuthProvider | undefined => {
    const p = graph()
      ? "microsoftGraph"
      : browserSignInProvider({
          imap: { host: host().trim() },
          smtp: { host: smtpHost().trim() },
        });
    return p !== undefined && offered().has(p) ? p : undefined;
  };
  const anyOffered = () => offered().size > 0;
  const busy = () => checking() || lookingUp() !== null || browserSignIn.phase() !== "idle";
  /** The list of rule 3, a hint's provider first; Microsoft only when it can be added. */
  const choices = () =>
    choicesFor(
      lookedUp().provider,
      (id) => mailProvider(id)?.transport !== "graph" || offered().has("microsoftGraph"),
    );
  const current = () => currentChoice(route());
  // The server fields: for *Another mail server* while the list is open, or nothing was found.
  const serversOpen = () => current() === "other" && (listOpen() || !found());
  const line = () => foundLine(route(), domain() ?? "", host());

  function useServers(servers: DiscoveredServers) {
    setHost(servers.imap.host);
    setPort(String(servers.imap.port));
    setSecurity(servers.imap.security);
    setUsername(suggestedUsername(servers, address().trim()));
    setSmtpUsername(suggestedSmtpUsername(servers, address().trim()));
    setSmtpHost(servers.smtp?.host ?? "");
    setSmtpPort(String(servers.smtp?.port ?? 465));
    setSmtpSecurity(servers.smtp?.security === "starttls" ? "starttls" : "tls");
  }

  /** Nothing knew the domain: the usual names as a start, to correct by hand. */
  function usualServers() {
    const d = domain() ?? "";
    setHost(`imap.${d}`);
    setPort("993");
    setSecurity("tls");
    setUsername(address().trim());
    setSmtpUsername("");
    setSmtpHost(`smtp.${d}`);
    setSmtpPort("465");
    setSmtpSecurity("tls");
  }

  /** *Enter the servers* of the blocked screen: the usual names, with *Another mail server* taken. */
  function enterServers() {
    setChosen({ address: address().trim().toLowerCase(), choice: "other" });
    setListOpen(true);
    void follow({ kind: "other" });
  }

  /**
   * Goes where the route leads (ADR 0135, rules 3 to 5; ADR 0136, rule 13). A provider chosen by
   * hand whose servers come from lookup (rule 6) is looked up here.
   */
  async function follow(next: SetupRoute) {
    setMicrosoft(false);
    switch (next.kind) {
      case "graph":
        setRoute(next);
        setFound(true);
        setStep("password");
        return;
      case "servers": {
        setRoute(next);
        setFound(true);
        useServers(next.servers);
        // Microsoft lists password sign-in in its published settings but refuses it over IMAP.
        setMicrosoft(needsBrowserSignIn(next.servers));
        // Its servers take a browser sign-in when this build offers it (ADR 0133).
        const step = setupStepFor(next.servers, (p) => offered().has(p));
        setStep(step === "browser" ? "password" : step);
        return;
      }
      case "providerServers": {
        setStep("password");
        setLookingUp(next.provider);
        const asked = address();
        try {
          const { found: servers } = await props.backend.discoverServers(next.settingsDomain);
          if (address() !== asked) return;
          if (!servers) throw new Error("nothing found");
          setRoute(next);
          setFound(true);
          useServers(servers);
          // Its usual user name is the whole address (the settings say so).
          setUsername(suggestedUsername(servers, address().trim()));
          setStep(
            setupStepFor(servers, (p) => offered().has(p)) === "blocked" ? "blocked" : "password",
          );
        } catch {
          if (address() !== asked) return;
          // Nothing is taken: what was there before is not what the person chose.
          setRoute({ kind: "choose" });
          setFound(false);
          const name = mailProvider(next.provider)?.name ?? "The provider";
          setError(
            `${name}'s settings couldn't be looked up just now. Check your internet connection and choose it again, or choose Another mail server.`,
          );
          setListOpen(true);
        } finally {
          setLookingUp(null);
        }
        return;
      }
      case "other":
        setRoute(next);
        setFound(false);
        usualServers();
        setStep("password");
        return;
      case "choose":
        setRoute(next);
        setFound(false);
        setStep("password");
        return;
      case "microsoftBlocked":
        setRoute(next);
        setMicrosoft(true);
        setStep("blocked");
        return;
    }
  }

  /** The person's answer in the list (rule 3); it holds until the address changes (rule 4). */
  function choose(choice: MailChoice) {
    if (busy()) return;
    setError("");
    setEvidence("");
    setOutgoingFailed(false);
    browserSignIn.clear();
    setChosen({ address: address().trim().toLowerCase(), choice });
    // A provider takes the list's place; *Another mail server* opens the fields under it.
    setListOpen(choice === "other");
    void follow(routeFor(lookedUp(), choice, offered().has("microsoftGraph")));
  }

  /** The choice made for this address, if the address has not changed since (rule 4). */
  const choiceHeld = (): MailChoice | undefined => {
    const c = chosen();
    return c !== null && c.address === address().trim().toLowerCase() ? c.choice : undefined;
  };

  // The lookup whose answer setup is waiting for; an older one that ends later is dropped.
  let lookups = 0;

  async function find() {
    const d = domain();
    if (!d) {
      setError("That doesn't look like an email address yet.");
      return;
    }
    setError("");
    setEvidence("");
    setOutgoingFailed(false);
    setListOpen(false);
    setStep("finding");
    const lookup = ++lookups;
    let answer: LookedUp = { servers: null };
    try {
      const [{ found: servers, provider }] = await Promise.all([
        props.backend.discoverServers(d),
        offeredReady,
      ]);
      answer = { servers, ...(provider === undefined ? {} : { provider }) };
    } catch {
      // Lookup failed: as if it found nothing, so the list is there at once.
    }
    // *Change* was pressed meanwhile, or another lookup started: this answer is for nobody.
    if (lookup !== lookups || step() !== "finding") return;
    setLookedUp(answer);
    // What the person said for this address wins over what was found (rule 4).
    const held = choiceHeld();
    if (held === "other") setListOpen(true);
    await follow(routeFor(answer, held, offered().has("microsoftGraph")));
  }

  /** The account as typed, with a password or with the handle of a browser sign-in. */
  async function add(
    how: { readonly password: string } | { readonly signIn: string },
    outgoing: boolean,
  ) {
    const name = yourName().trim() === "" ? {} : { displayName: yourName().trim() };
    // Over Graph: the sign-in's handle and no servers (ADR 0136, rules 2 and 13).
    const overGraph = graph() && "signIn" in how;
    const r = overGraph
      ? await props.backend.addAccount({
          address: address().trim(),
          ...name,
          transport: "graph",
          signIn: how.signIn,
        })
      : await addOverImap(how, outgoing, name);
    setAdded({
      account: r.account,
      folderCount: r.folderCount,
      smtpHost: overGraph ? "" : outgoing ? smtpHost().trim() : "",
      signedIn: "signIn" in how,
      graph: overGraph,
    });
    setEveryAdded((all) => [...all.filter((a) => a.id !== r.account.id), r.account]);
    if (firstRun()) setStep("done");
    props.onAdded(r.account);
  }

  function addOverImap(
    how: { readonly password: string } | { readonly signIn: string },
    outgoing: boolean,
    name: { readonly displayName?: string },
  ) {
    return props.backend.addAccount({
      address: address().trim(),
      ...name,
      ...how,
      imap: {
        host: host().trim(),
        port: Number(port()),
        security: security(),
        username: username().trim(),
      },
      ...(outgoing
        ? {
            smtp: {
              host: smtpHost().trim(),
              port: Number(smtpPort()),
              security: smtpSecurity(),
              username: smtpUsername().trim() || username().trim(),
            },
          }
        : {}),
    });
  }

  const failureContext = (): FailureContext => ({
    host: host().trim(),
    port: Number(port()),
    smtpHost: smtpHost().trim(),
    browserSignIn: anyOffered(),
    ...(graph() ? { transport: "graph" as const } : {}),
  });

  /** What a failed attempt shows: the sentence, the server's words, and what can be changed. */
  function showFailure(e: unknown) {
    setError(explainFailure(e, failureContext()));
    setEvidence(failureEvidence(e, graph()) ?? "");
    const code = (e as { code?: unknown }).code;
    // Over Graph there is no outgoing server to leave out: sending is the same sign-in.
    setOutgoingFailed(!graph() && (code === "outgoingAuthFailed" || code === "outgoingFailed"));
    // What was found did not work: show it, so it can be corrected. Not when a provider's own
    // server refused a browser sign-in: its servers are the right ones, and the sentence says
    // what to do (ADR 0133, rule 10).
    const refusedAtProvider =
      provider() !== undefined && (code === "authFailed" || code === "outgoingAuthFailed");
    if (
      code !== "accountExists" &&
      code !== "credentialsUnavailable" &&
      !refusedAtProvider &&
      !graph()
    ) {
      setListOpen(true);
    }
  }

  /**
   * The browser sign-in, then the same test and save as with a password (ADR 0133, rule 6). The
   * failure of the sign-in itself is said in its own sentence; the servers' as for a password.
   */
  async function signInAndConnect(withOutgoing = true) {
    const p = provider();
    if (p === undefined || busy()) return;
    setError("");
    setEvidence("");
    setOutgoingFailed(false);
    const outgoing = !graph() && withOutgoing && smtpHost().trim() !== "";
    await browserSignIn.run(
      p,
      address().trim(),
      (handle) => add({ signIn: handle }, outgoing),
      (e) => {
        showFailure(e);
        return { sentence: "" };
      },
    );
  }

  async function connect(withOutgoing = true) {
    if (provider() !== undefined) return signInAndConnect(withOutgoing);
    setError("");
    setEvidence("");
    setOutgoingFailed(false);
    setChecking(true);
    const outgoing = withOutgoing && smtpHost().trim() !== "";
    try {
      await add({ password: password() }, outgoing);
      setPassword("");
    } catch (e) {
      showFailure(e);
    } finally {
      setChecking(false);
    }
  }

  // With a browser sign-in there is no password to wait for (ADR 0133, rule 11).
  // The sign-in's own failure, or the servers' when the backend refused what it gave.
  const shownError = () => error() || browserSignIn.failure();
  const shownEvidence = () => (error() !== "" ? evidence() : browserSignIn.evidence());
  const connectLabel = () => {
    const p = provider();
    if (p === undefined) return checking() ? "Checking your mailbox…" : "Connect";
    switch (browserSignIn.phase()) {
      case "browser":
        return "Waiting for your browser…";
      case "checking":
        return "Checking your mailbox…";
      default:
        return `Sign in with ${providerName(p)}`;
    }
  };

  const ready = () =>
    route().kind !== "choose" &&
    lookingUp() === null &&
    ((graph() && provider() !== undefined) ||
      ((provider() !== undefined || password() !== "") &&
        host().trim() !== "" &&
        Number(port()) > 0 &&
        username().trim() !== ""));

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy()) return;
    if (step() === "address") void find();
    else if (step() === "password" && ready()) void connect();
    else if (step() === "done") afterDone();
  }

  /** "You're in." is answered: the two questions about AI follow, unless they were declined. */
  function afterDone() {
    if (readDeclined()) props.onFinished?.();
    else setStep("runtime");
  }

  function declineAi() {
    writeDeclined(true);
    props.onFinished?.();
  }

  function takeAgentStatus(status: AgentStatus) {
    setAgent(status);
    props.onAgentStatus?.(status);
  }

  /** `Add another account`: back to the address question; the accounts so far are kept. */
  function addAnother() {
    setAddress("");
    setPassword("");
    setYourName("");
    setError("");
    setListOpen(false);
    setAdded(null);
    setStep("address");
  }

  const headline = firstRun()
    ? "font-serif text-[29px] leading-[1.2] font-semibold tracking-[-0.012em] text-balance"
    : "font-serif text-[21px] leading-[1.25] font-semibold text-balance";

  const form = (
    <form
      onSubmit={submit}
      aria-label="Add account"
      class="flex w-full max-w-[500px] flex-col gap-5"
      classList={{ "px-6 py-7": !firstRun() }}
    >
      <Show when={step() === "finding" || step() === "password" || step() === "blocked"}>
        <p class="flex items-baseline gap-2.5 font-serif text-[15px] text-mid">
          <span class="min-w-0 truncate">{address().trim()}</span>
          <button
            type="button"
            class={`${textButton} font-sans`}
            disabled={busy()}
            onClick={() => {
              browserSignIn.clear();
              setStep("address");
            }}
          >
            Change
          </button>
        </p>
      </Show>

      <Show when={step() === "address"}>
        <div class="settle flex flex-col gap-5">
          <Show
            when={firstRun()}
            fallback={<h2 class={headline}>Which address do you want to add?</h2>}
          >
            <div class="flex flex-col gap-2.5">
              <h1 class={headline}>Let's bring your mail here.</h1>
              <p class="text-[14px] leading-[1.5] text-mid">
                It's kept and searched on this Mac, and nothing goes out without your yes. All we
                need to start is your address.
              </p>
            </div>
          </Show>
          <div>
            <label class={label} for="setup-email">
              Email address
            </label>
            <input
              id="setup-email"
              ref={(el) => queueMicrotask(() => el.focus())}
              type="email"
              autocomplete="off"
              spellcheck={false}
              placeholder="you@yourcompany.com"
              class={bigInput}
              value={address()}
              onInput={(e) => {
                setAddress(e.currentTarget.value);
                setError("");
              }}
            />
          </div>
          <Show when={error() !== ""}>
            <p role="alert" class="text-[13px] text-late">
              {error()}
            </p>
          </Show>
          <div class="flex items-center gap-3">
            <button type="submit" class={pillPrimary} disabled={domain() === null}>
              Continue <span class="ml-1.5 font-normal opacity-60">↵</span>
            </button>
            <Show when={props.onCancel}>
              <button type="button" class={pill} onClick={() => props.onCancel?.()}>
                Cancel
              </button>
            </Show>
          </div>
          <div class="flex flex-col gap-1.5 text-[12px] leading-[1.5] text-secondary">
            <p>
              {anyOffered()
                ? "Works with any IMAP mailbox: your company's server or your host's. Microsoft accounts sign in through your browser; Gmail gets proper sign-in later."
                : "Works with any IMAP mailbox: your company's server or your host's. Gmail and Microsoft 365 get proper sign-in later."}
            </p>
            <p>
              To find your servers we look up only{" "}
              <Show when={domain()} fallback="the part after the @">
                {(d) => <strong class="font-semibold text-mid">{d()}</strong>}
              </Show>
              : in DNS, at the domain itself and in Mozilla's settings database. Your address and
              password go only to your mail server.
            </p>
          </div>
        </div>
      </Show>

      <Show when={step() === "finding"}>
        <p class={`${headline} settle text-mid`} role="status">
          Looking up {domain()}…
        </p>
      </Show>

      <Show when={step() === "blocked"}>
        <div class="settle flex flex-col gap-3">
          <h2 class={headline}>
            {microsoft()
              ? `${domain()} is on Microsoft's mail, which needs browser sign-in.`
              : `${lookedUp().servers?.displayName || domain()} needs browser sign-in.`}
          </h2>
          <p class="text-[14px] leading-[1.5] text-mid">
            {microsoft()
              ? "Matters can't do that yet, and Microsoft doesn't take passwords from mail apps there. Try another address for now, or enter the servers if your admin gave you a different way in."
              : "Matters can't do that yet, and a password won't work there. Try another address for now, or enter the servers if your admin gave you a different way in."}
          </p>
          <div class="flex gap-3">
            <button type="button" class={pillPrimary} onClick={() => setStep("address")}>
              Use another address
            </button>
            <button type="button" class={pill} onClick={enterServers}>
              Enter the servers
            </button>
          </div>
        </div>
      </Show>

      <Show when={step() === "password"}>
        <div class="settle flex flex-col gap-4">
          <Show
            when={found()}
            fallback={
              <div class="flex flex-col gap-2">
                <h2 class={headline}>We couldn't find the servers for {domain()}.</h2>
                <p class="text-[13.5px] leading-[1.5] text-mid">
                  {serversOpen()
                    ? "Your host's help pages list them, usually under IMAP settings. We've put in the usual names as a start."
                    : "Who runs your mail? Choose it here, or enter the servers yourself."}
                </p>
              </div>
            }
          >
            <p class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-serif text-[15px] text-mid">
              <span>{line()}</span>
              <button
                type="button"
                aria-expanded={listOpen()}
                aria-controls="setup-who"
                class={`${textButton} font-sans`}
                disabled={busy()}
                onClick={() => setListOpen(!listOpen())}
              >
                {listOpen() ? "Hide" : "Not right?"}
              </button>
            </p>
          </Show>

          <Show when={listOpen() || !found()}>
            <WhoRunsList
              choices={choices()}
              current={current()}
              disabled={busy()}
              onChoose={choose}
            />
          </Show>

          <Show when={lookingUp()}>
            {(id) => (
              <p class="text-[13.5px] text-mid" role="status">
                Looking up {mailProvider(id())?.name ?? ""}'s settings…
              </p>
            )}
          </Show>

          <Show when={serversOpen()}>
            <Servers
              host={host()}
              port={port()}
              security={security()}
              username={username()}
              smtpUsername={smtpUsername()}
              smtpHost={smtpHost()}
              smtpPort={smtpPort()}
              smtpSecurity={smtpSecurity()}
              onHost={setHost}
              onPort={setPort}
              onSecurity={setSecurity}
              onUsername={setUsername}
              onSmtpUsername={setSmtpUsername}
              onSmtpHost={setSmtpHost}
              onSmtpPort={setSmtpPort}
              onSmtpSecurity={setSmtpSecurity}
            />
          </Show>

          <Show when={found() && lookingUp() === null}>
            <h2 class={headline}>
              {provider()
                ? `Now sign in with ${providerName(provider() ?? "microsoft")}.`
                : "And the password?"}
            </h2>
          </Show>

          <Show when={route().kind === "choose" || lookingUp() !== null}>
            <Show when={shownError() !== ""}>
              <p role="alert" class="text-[13px] leading-[1.45] text-late">
                {shownError()}
              </p>
            </Show>
          </Show>

          <Show when={route().kind !== "choose" && lookingUp() === null}>
            <Show
              when={!provider()}
              fallback={
                <SignInLine
                  provider={provider() ?? "microsoft"}
                  address={address().trim()}
                  phase={browserSignIn.phase()}
                />
              }
            >
              <div>
                <div class="flex items-baseline justify-between">
                  <label class={label} for="setup-password">
                    Password for {address().trim()}
                  </label>
                  <button
                    type="button"
                    class={textButton}
                    aria-pressed={revealed()}
                    onClick={() => setRevealed(!revealed())}
                  >
                    {revealed() ? "Hide" : "Show"}
                  </button>
                </div>
                <input
                  id="setup-password"
                  ref={(el) => queueMicrotask(() => el.focus())}
                  type={revealed() ? "text" : "password"}
                  autocomplete="off"
                  spellcheck={false}
                  class={bigInput}
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                />
                <p class="mt-2 text-[12.5px] leading-[1.5] text-secondary">
                  {passwordHint(host(), anyOffered())}
                </p>
              </div>
            </Show>

            <div>
              <label class={label} for="setup-name">
                Your name on mail you send (optional)
              </label>
              <input
                id="setup-name"
                class={`${field} w-full`}
                autocomplete="off"
                spellcheck={false}
                value={yourName()}
                onInput={(e) => setYourName(e.currentTarget.value)}
              />
            </div>

            <Show when={shownError() !== ""}>
              <div role="alert" class="flex flex-col gap-2.5 rounded-[10px] bg-fill px-3.5 py-3">
                <p class="text-[13px] leading-[1.45] text-late">{shownError()}</p>
                <Show when={shownEvidence() !== ""}>
                  <p class="selectable text-[12px] leading-[1.45] break-words text-secondary">
                    {shownEvidence()}
                  </p>
                </Show>
                <Show when={outgoingFailed()}>
                  <div>
                    <button
                      type="button"
                      class={pill}
                      disabled={busy() || !ready()}
                      onClick={() => void connect(false)}
                    >
                      Add it without sending
                    </button>
                  </div>
                </Show>
              </div>
            </Show>

            <div class="flex items-center gap-3">
              <button type="submit" class={pillPrimary} disabled={busy() || !ready()}>
                {connectLabel()}
                <Show when={!busy()}>
                  <span class="ml-1.5 font-normal opacity-60">↵</span>
                </Show>
              </button>
              <Show
                when={browserSignIn.phase() !== "browser"}
                fallback={
                  <button type="button" class={pill} onClick={() => browserSignIn.cancel()}>
                    Cancel
                  </button>
                }
              >
                <Show when={props.onCancel}>
                  <button
                    type="button"
                    class={pill}
                    disabled={busy()}
                    onClick={() => props.onCancel?.()}
                  >
                    Cancel
                  </button>
                </Show>
              </Show>
            </div>

            <p class="text-[12px] text-secondary">
              {provider()
                ? "We test the sign-in before saving anything. It's encrypted with your Mac's keychain."
                : "We test the login before saving anything. The password is encrypted with your Mac's keychain."}
            </p>
          </Show>
          <Show when={route().kind === "choose" && props.onCancel}>
            <div>
              <button type="button" class={pill} onClick={() => props.onCancel?.()}>
                Cancel
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={step() === "done" && added()}>
        {(a) => (
          <Done
            added={a()}
            headline={headline}
            status={
              props.accounts
                ? describeStatus(
                    props.accounts.statusOf(a().account.id),
                    provider() !== undefined,
                    a().graph,
                  ).text
                : ""
            }
            more={!readDeclined()}
            signedIn={a().signedIn}
          />
        )}
      </Show>

      <Show when={step() === "runtime"}>
        <RuntimeStep
          backend={props.backend}
          headline={headline}
          onStatus={takeAgentStatus}
          onBusy={setAgentBusy}
          onContinue={(status) => {
            takeAgentStatus(status);
            setStep("read");
          }}
          onDeclined={declineAi}
        />
      </Show>

      <Show when={step() === "read" ? agent() : null}>
        {(status) => (
          <ReadStep
            backend={props.backend}
            headline={headline}
            status={status()}
            accounts={everyAdded()}
            onAddAccount={addAnother}
            onStatus={takeAgentStatus}
            onStarted={(next) => {
              takeAgentStatus(next);
              props.onFinished?.();
            }}
            onDeclined={declineAi}
          />
        )}
      </Show>
    </form>
  );

  return (
    <Show when={firstRun()} fallback={form}>
      <div class="relative flex h-full flex-col overflow-hidden bg-bg">
        <div class="drag h-[52px] shrink-0" />
        <BigMark busy={step() === "finding" || busy() || agentBusy()} />
        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div class="flex min-h-full flex-col justify-center pr-8 pb-[9vh] pl-[max(32px,11vw)]">
            <div class="mb-9 flex items-center gap-2 text-[13px] font-semibold">
              <MattersMark size={16} />
              Matters
            </div>
            {form}
          </div>
        </div>
      </div>
    </Show>
  );
}

function Done(props: {
  added: { account: AccountInfo; folderCount: number; smtpHost: string; graph: boolean };
  headline: string;
  status: string;
  /** Two questions about AI follow, so this button goes on instead of opening the mail. */
  more: boolean;
  /** Added with a browser sign-in (ADR 0133). */
  signedIn: boolean;
}) {
  const folders = () =>
    props.added.folderCount === 1 ? "1 folder" : `${props.added.folderCount} folders`;
  return (
    <div class="settle flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <h1 class={props.headline}>You're in.</h1>
        <p class="font-serif text-[15px] text-mid">{props.added.account.address}</p>
      </div>
      <ul class="m-0 flex list-none flex-col gap-2 p-0 text-[13.5px]">
        <Check>
          Signed in to {props.added.graph ? "Microsoft" : props.added.account.host}, {folders()}{" "}
          found
        </Check>
        <Show
          when={props.added.graph || props.added.smtpHost !== ""}
          fallback={<li class="pl-6 text-secondary">Read only: no outgoing server yet</li>}
        >
          <Check>
            Sending works through {props.added.graph ? "Microsoft" : props.added.smtpHost}
          </Check>
        </Show>
        <Check>
          {props.signedIn
            ? "Sign-in encrypted with your Mac's keychain"
            : "Password encrypted with your Mac's keychain"}
        </Check>
      </ul>
      <Show when={props.status !== ""}>
        <p class="text-[12.5px] text-secondary" role="status" aria-live="polite">
          {props.status}. You can start reading while the rest arrives.
        </p>
      </Show>
      <div>
        <button type="submit" class={pillPrimary} ref={(el) => queueMicrotask(() => el.focus())}>
          {props.more ? "Continue" : "Open your mail"}{" "}
          <span class="ml-1.5 font-normal opacity-60">↵</span>
        </button>
      </div>
    </div>
  );
}

/**
 * In the password field's place on servers that take only a browser sign-in (ADR 0133, rule 11):
 * that the browser opens, and while it is open, that setup waits for it.
 */
function SignInLine(props: { provider: OAuthProvider; address: string; phase: SignInPhase }) {
  const name = () => providerName(props.provider);
  return (
    <p
      class="flex items-start gap-2.5 text-[14px] leading-[1.5] text-mid"
      role="status"
      aria-live="polite"
    >
      <Show when={props.phase !== "idle"}>
        <span class="mt-[4px] inline-flex shrink-0 animate-spin">
          <Ring size={14} />
        </span>
      </Show>
      <span>
        {props.phase === "browser"
          ? `Waiting for you to sign in to ${props.address} in your browser. Matters comes back to the front when you're done.`
          : props.phase === "checking"
            ? `Signed in with ${name()}. Checking your mailbox…`
            : `Your browser opens at ${name()}'s sign-in page for ${props.address}. Matters never sees your password there.`}
      </span>
    </p>
  );
}

function Check(props: { children: unknown }) {
  return (
    <li class="flex items-start gap-2">
      <svg
        class="mt-[3px] shrink-0 text-good"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
      <span>{props.children as never}</span>
    </li>
  );
}

/**
 * The app's mark as large as the window, where the loading screen leaves off: the M is quiet, the
 * ball is the one colour. Its place and size are in styles.css (`.big-mark`): whole, in the room
 * after the form column. Under 1000 px there is no room, so it is not drawn.
 */
function BigMark(props: { busy: boolean }) {
  const master = markMaster(48);
  return (
    <svg
      aria-hidden="true"
      viewBox={master.viewBox}
      class="big-mark pointer-events-none absolute top-1/2 h-auto -translate-y-1/2 overflow-visible max-[1000px]:hidden"
      classList={{ "big-mark-busy": props.busy }}
    >
      <path class="big-mark-m" d={master.m} fill="var(--hairline)" />
      <g class="big-mark-weigh">
        <circle
          class="big-mark-ball"
          cx={master.ball.cx}
          cy={master.ball.cy}
          r={master.ball.r}
          fill="var(--mark-ball)"
        />
      </g>
    </svg>
  );
}

/**
 * Who runs the mail, said by the person (ADR 0135, rule 3): the providers Matters can add by name
 * and *Another mail server*, as radio buttons in the app's bordered rows. Choosing one takes
 * effect at once; the arrow keys move between them.
 */
function WhoRunsList(props: {
  choices: readonly MailChoice[];
  current: MailChoice | undefined;
  disabled: boolean;
  onChoose: (choice: MailChoice) => void;
}) {
  return (
    <div
      id="setup-who"
      role="radiogroup"
      aria-label="Who runs your mail"
      class="settle flex flex-col gap-2"
    >
      <For each={props.choices}>
        {(choice) => (
          <label
            data-mail-choice={choice}
            class="flex cursor-default items-start gap-2.5 rounded-[10px] border p-3"
            classList={{
              "border-edge": props.current === choice,
              "border-hairline": props.current !== choice,
            }}
          >
            <input
              type="radio"
              name="setup-who"
              class="mt-[3px]"
              checked={props.current === choice}
              disabled={props.disabled}
              onChange={() => props.onChoose(choice)}
            />
            <span class="min-w-0 flex-1">
              <span class="block text-[13.5px] font-semibold">{choiceLabel(choice)}</span>
              <span class="block text-[12px] text-secondary">{choiceNote(choice)}</span>
            </span>
          </label>
        )}
      </For>
    </div>
  );
}

function Servers(props: {
  host: string;
  port: string;
  security: TransportSecurity;
  username: string;
  smtpUsername: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: TransportSecurity;
  onHost: (v: string) => void;
  onPort: (v: string) => void;
  onSecurity: (v: TransportSecurity) => void;
  onUsername: (v: string) => void;
  onSmtpUsername: (v: string) => void;
  onSmtpHost: (v: string) => void;
  onSmtpPort: (v: string) => void;
  onSmtpSecurity: (v: TransportSecurity) => void;
}) {
  const row = "grid grid-cols-[minmax(0,1fr)_72px_112px] gap-2";
  const wide = `${field} w-full`;
  return (
    <div class="settle flex flex-col gap-3.5 rounded-[10px] border border-hairline p-3.5">
      <div class={row}>
        <div>
          <label class={label} for="setup-host">
            Incoming server (IMAP)
          </label>
          <input
            id="setup-host"
            class={wide}
            spellcheck={false}
            value={props.host}
            onInput={(e) => props.onHost(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class={label} for="setup-port">
            Port
          </label>
          <input
            id="setup-port"
            inputmode="numeric"
            class={wide}
            value={props.port}
            onInput={(e) => props.onPort(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class={label} for="setup-security">
            Encryption
          </label>
          <select
            id="setup-security"
            class={wide}
            value={props.security}
            onChange={(e) => props.onSecurity(e.currentTarget.value as TransportSecurity)}
          >
            <option value="tls">TLS</option>
            <option value="starttls">STARTTLS</option>
          </select>
        </div>
      </div>
      <div class={row}>
        <div>
          <label class={label} for="setup-smtp-host">
            Outgoing server (SMTP)
          </label>
          <input
            id="setup-smtp-host"
            class={wide}
            spellcheck={false}
            value={props.smtpHost}
            onInput={(e) => props.onSmtpHost(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class={label} for="setup-smtp-port">
            Port
          </label>
          <input
            id="setup-smtp-port"
            inputmode="numeric"
            class={wide}
            value={props.smtpPort}
            onInput={(e) => props.onSmtpPort(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class={label} for="setup-smtp-security">
            Encryption
          </label>
          <select
            id="setup-smtp-security"
            class={wide}
            value={props.smtpSecurity}
            onChange={(e) => props.onSmtpSecurity(e.currentTarget.value as TransportSecurity)}
          >
            <option value="tls">TLS</option>
            <option value="starttls">STARTTLS</option>
          </select>
        </div>
      </div>
      <div>
        <label class={label} for="setup-username">
          User name
        </label>
        <input
          id="setup-username"
          class={wide}
          spellcheck={false}
          value={props.username}
          onInput={(e) => props.onUsername(e.currentTarget.value)}
        />
      </div>
      <div>
        <label class={label} for="setup-smtp-username">
          Outgoing user name
        </label>
        <input
          id="setup-smtp-username"
          class={wide}
          spellcheck={false}
          placeholder="Same as above"
          value={props.smtpUsername}
          onInput={(e) => props.onSmtpUsername(e.currentTarget.value)}
        />
      </div>
      <p class="text-[11.5px] text-secondary">
        Leave the outgoing server empty to read mail without sending.
      </p>
    </div>
  );
}
