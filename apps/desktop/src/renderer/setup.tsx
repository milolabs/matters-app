import type { AccountInfo } from "@matters/contracts";
import {
  type AgentStatus,
  type DiscoveredServers,
  domainOfAddress,
  needsBrowserSignIn,
  suggestedSmtpUsername,
  suggestedUsername,
  type TransportSecurity,
  takesPassword,
} from "@matters/core";
import { createSignal, onCleanup, Show } from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import { readDeclined, writeDeclined } from "./agentPrefs.ts";
import { ReadStep, RuntimeStep } from "./agentSetup.tsx";
import type { Backend } from "./client.ts";
import { explainFailure, type FailureContext, failureEvidence, passwordHint } from "./explain.ts";
import { Ring } from "./icons.tsx";
import { describeStatus } from "./status.ts";
import { field, pill, pillPrimary } from "./ui.ts";

type Step = "address" | "finding" | "password" | "blocked" | "done" | "runtime" | "read";

/** How far along the big ring is. It closes with the last answer: the mailbox, then who reads it. */
const PROGRESS: Readonly<Record<Step, number>> = {
  address: 0.14,
  finding: 0.34,
  password: 0.62,
  blocked: 0.46,
  done: 0.78,
  runtime: 0.88,
  read: 0.95,
};

const label = "mb-1 block text-[12px] text-secondary";
const bigInput =
  "selectable h-12 w-full border-0 border-b-[1.5px] border-edge bg-transparent font-serif text-[22px] outline-none placeholder:text-edge focus:border-ink";
const textButton = "cursor-default text-[12.5px] text-mid underline-offset-2 hover:underline";

/**
 * Connecting a mailbox, one question at a time: the address, then the password; the servers come
 * from a lookup (ADR 0023) and are shown to correct. What is answered stays on the page as a line
 * of the conversation and can be changed. With `onFinished` this is the first thing a new user
 * sees and ends on a success screen; without it, it is the form inside the Accounts dialog.
 */
export function Setup(props: {
  backend: Backend;
  onAdded: (account: AccountInfo) => void;
  onCancel?: () => void;
  accounts?: AccountsStore;
  onFinished?: () => void;
  /** AI was turned on or its status changed here: the window outside is told. */
  onAgentStatus?: (status: AgentStatus) => void;
}) {
  const firstRun = () => props.onFinished !== undefined;
  const [step, setStep] = createSignal<Step>("address");
  const [address, setAddress] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [revealed, setRevealed] = createSignal(false);
  const [yourName, setYourName] = createSignal("");
  const [found, setFound] = createSignal(false);
  const [foundName, setFoundName] = createSignal("");
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal("993");
  const [security, setSecurity] = createSignal<TransportSecurity>("tls");
  const [username, setUsername] = createSignal("");
  // Outgoing server (ADR 0020); it shares the password with IMAP, and the user name while its own is empty.
  const [smtpHost, setSmtpHost] = createSignal("");
  const [smtpUsername, setSmtpUsername] = createSignal("");
  const [smtpPort, setSmtpPort] = createSignal("465");
  const [smtpSecurity, setSmtpSecurity] = createSignal<TransportSecurity>("tls");
  const [serversOpen, setServersOpen] = createSignal(false);
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
  } | null>(null);
  // Every account added in this run, for the question about reading them (first run only).
  const [everyAdded, setEveryAdded] = createSignal<readonly AccountInfo[]>([]);
  const [agent, setAgent] = createSignal<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = createSignal(false);

  // The password is held in this component only; it is dropped when the screen goes away.
  onCleanup(() => setPassword(""));

  const domain = () => domainOfAddress(address().trim());

  function useServers(servers: DiscoveredServers) {
    setFound(true);
    setFoundName(servers.displayName ?? "");
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
  function enterServers() {
    const d = domain() ?? "";
    setFound(false);
    setFoundName("");
    setHost(`imap.${d}`);
    setPort("993");
    setSecurity("tls");
    setUsername(address().trim());
    setSmtpUsername("");
    setSmtpHost(`smtp.${d}`);
    setSmtpPort("465");
    setSmtpSecurity("tls");
    setServersOpen(true);
    setStep("password");
  }

  async function find() {
    const d = domain();
    if (!d) {
      setError("That doesn't look like an email address yet.");
      return;
    }
    setError("");
    setOutgoingFailed(false);
    setServersOpen(false);
    setStep("finding");
    try {
      const { found: servers } = await props.backend.discoverServers(d);
      if (!servers) {
        enterServers();
        return;
      }
      useServers(servers);
      // Microsoft lists password sign-in in its published settings but refuses it over IMAP.
      setMicrosoft(needsBrowserSignIn(servers));
      setStep(takesPassword(servers) ? "password" : "blocked");
    } catch {
      enterServers();
    }
  }

  async function connect(withOutgoing = true) {
    setError("");
    setEvidence("");
    setOutgoingFailed(false);
    setChecking(true);
    const context: FailureContext = {
      host: host().trim(),
      port: Number(port()),
      smtpHost: smtpHost().trim(),
    };
    const outgoing = withOutgoing && smtpHost().trim() !== "";
    try {
      const r = await props.backend.addAccount({
        address: address().trim(),
        ...(yourName().trim() === "" ? {} : { displayName: yourName().trim() }),
        password: password(),
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
      setPassword("");
      setAdded({
        account: r.account,
        folderCount: r.folderCount,
        smtpHost: outgoing ? smtpHost().trim() : "",
      });
      setEveryAdded((all) => [...all.filter((a) => a.id !== r.account.id), r.account]);
      if (firstRun()) setStep("done");
      props.onAdded(r.account);
    } catch (e) {
      setError(explainFailure(e, context));
      setEvidence(failureEvidence(e) ?? "");
      const code = (e as { code?: unknown }).code;
      setOutgoingFailed(code === "outgoingAuthFailed" || code === "outgoingFailed");
      // What was found did not work: show it, so it can be corrected.
      if (code !== "accountExists" && code !== "credentialsUnavailable") setServersOpen(true);
    } finally {
      setChecking(false);
    }
  }

  const ready = () =>
    password() !== "" && host().trim() !== "" && Number(port()) > 0 && username().trim() !== "";

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (checking()) return;
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
    setServersOpen(false);
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
            disabled={checking()}
            onClick={() => setStep("address")}
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
              Works with any IMAP mailbox: your company's server or your host's. Gmail and Microsoft
              365 get proper sign-in later.
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
              : `${foundName() || domain()} needs browser sign-in.`}
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
                  Your host's help pages list them, usually under IMAP settings. We've put in the
                  usual names as a start.
                </p>
              </div>
            }
          >
            <p class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-serif text-[15px] text-mid">
              <span>
                {foundName() === "" ? `Found ${host()}` : `Found ${foundName()}: ${host()}`}
              </span>
              <button
                type="button"
                aria-expanded={serversOpen()}
                class={`${textButton} font-sans`}
                onClick={() => setServersOpen(!serversOpen())}
              >
                {serversOpen() ? "Hide servers" : "Not right?"}
              </button>
            </p>
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

          <Show when={found()}>
            <h2 class={headline}>And the password?</h2>
          </Show>

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
            <p class="mt-2 text-[12.5px] leading-[1.5] text-secondary">{passwordHint(host())}</p>
          </div>

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

          <Show when={error() !== ""}>
            <div role="alert" class="flex flex-col gap-2.5 rounded-[10px] bg-fill px-3.5 py-3">
              <p class="text-[13px] leading-[1.45] text-late">{error()}</p>
              <Show when={evidence() !== ""}>
                <p class="selectable text-[12px] leading-[1.45] break-words text-secondary">
                  {evidence()}
                </p>
              </Show>
              <Show when={outgoingFailed()}>
                <div>
                  <button
                    type="button"
                    class={pill}
                    disabled={checking() || !ready()}
                    onClick={() => void connect(false)}
                  >
                    Add it without sending
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          <div class="flex items-center gap-3">
            <button type="submit" class={pillPrimary} disabled={checking() || !ready()}>
              {checking() ? "Checking your mailbox…" : "Connect"}
              <Show when={!checking()}>
                <span class="ml-1.5 font-normal opacity-60">↵</span>
              </Show>
            </button>
            <Show when={props.onCancel}>
              <button
                type="button"
                class={pill}
                disabled={checking()}
                onClick={() => props.onCancel?.()}
              >
                Cancel
              </button>
            </Show>
          </div>

          <p class="text-[12px] text-secondary">
            We test the login before saving anything. The password is encrypted with your Mac's
            keychain.
          </p>
        </div>
      </Show>

      <Show when={step() === "done" && added()}>
        {(a) => (
          <Done
            added={a()}
            headline={headline}
            status={
              props.accounts ? describeStatus(props.accounts.statusOf(a().account.id)).text : ""
            }
            more={!readDeclined()}
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
        <BigRing
          progress={PROGRESS[step()]}
          busy={step() === "finding" || checking() || agentBusy()}
        />
        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div class="flex min-h-full flex-col justify-center pr-8 pb-[9vh] pl-[max(32px,11vw)]">
            <div class="mb-9 flex items-center gap-2 text-[13px] font-semibold">
              <Ring size={15} />
              matters
            </div>
            {form}
          </div>
        </div>
      </div>
    </Show>
  );
}

function Done(props: {
  added: { account: AccountInfo; folderCount: number; smtpHost: string };
  headline: string;
  status: string;
  /** Two questions about AI follow, so this button goes on instead of opening the mail. */
  more: boolean;
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
          Signed in to {props.added.account.host}, {folders()} found
        </Check>
        <Show
          when={props.added.smtpHost !== ""}
          fallback={<li class="pl-6 text-secondary">Read only: no outgoing server yet</li>}
        >
          <Check>Sending works through {props.added.smtpHost}</Check>
        </Show>
        <Check>Password encrypted with your Mac's keychain</Check>
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

/** The mark of the app, as large as the window: its arc grows with each answer. */
function BigRing(props: { progress: number; busy: boolean }) {
  const R = 300;
  const circumference = 2 * Math.PI * R;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 720 720"
      class="pointer-events-none absolute top-1/2 right-[-210px] size-[720px] -translate-y-1/2 max-[1000px]:hidden"
      classList={{ "ring-busy": props.busy }}
    >
      <circle cx="360" cy="360" r={R} fill="none" stroke="var(--hairline)" stroke-width="30" />
      <circle
        class="ring-arc"
        cx="360"
        cy="360"
        r={R}
        fill="none"
        stroke={props.progress === 1 ? "var(--good)" : "var(--ink)"}
        stroke-width="30"
        stroke-linecap="round"
        stroke-dasharray={String(circumference)}
        stroke-dashoffset={String(circumference * (1 - props.progress))}
        transform="rotate(-90 360 360)"
      />
    </svg>
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
