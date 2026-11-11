// A runtime that answers from canned facts, for a run with no model (MATTERS_SEED=1): the app
// can be seen and smoke-tested over the demo mailbox without the person's plan, a program or a
// network. Every quote it gives is a passage it found in the text it was handed, so the code that
// holds quotes to the mail (ADR 0051, rule 9) is exercised for real. It exists only when the sync
// worker was started with the seed (see syncWorker.ts); a real database never gets one.
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  PlanLimits,
} from "@matters/core";
import {
  DRAFT_CLOSE,
  DRAFT_OPEN,
  draftGaps,
  GAPS_CLOSE,
  GAPS_OPEN,
  LAST_CLOSE,
  LAST_OPEN,
  REWRITE_HOW_TEXT,
} from "@matters/core";
import { TEST_PROMPT_QUOTE } from "./agentService.ts";

interface Rule {
  /** A passage of the seeded mail, copied exactly. */
  readonly find: string;
  readonly kind: "promise" | "ask";
  readonly who: "you" | "them";
  /** Which side wrote the message the passage is in. */
  readonly author: "you" | "them";
  readonly headline: string;
  readonly stakes?: "money" | "contract";
}

const RULES: readonly Rule[] = [
  {
    find: "Termin płatności upływa w piątek, prosimy o terminowe uregulowanie należności.",
    kind: "ask",
    who: "you",
    author: "them",
    headline: "Zapłać należność przed piątkiem",
    stakes: "money",
  },
  {
    find: "Czy możemy przesunąć spotkanie na jutro, na godzinę dziesiątą?",
    kind: "ask",
    who: "you",
    author: "them",
    headline: "Odpowiedz w sprawie przesunięcia spotkania",
  },
  {
    find: "proszę o potwierdzenie otrzymania",
    kind: "ask",
    who: "you",
    author: "them",
    headline: "Potwierdź otrzymanie dokumentów",
  },
  {
    find: "Łączę się z Państwem jeszcze dziś po południu",
    kind: "promise",
    who: "them",
    author: "them",
    headline: "Czekasz na kontakt w sprawie szczegółów",
  },
  {
    find: "Chętnie spotkam się na kawę",
    kind: "promise",
    who: "you",
    author: "you",
    headline: "Umów się na kawę",
  },
  {
    find: TEST_PROMPT_QUOTE,
    kind: "promise",
    who: "them",
    author: "them",
    headline: "Waiting for the signed contract",
    stakes: "contract",
  },
];

interface Block {
  readonly number: number;
  readonly own: boolean;
  readonly text: string;
}

/** The numbered messages of a rendered thread (see `renderThread` in core). */
function blocks(untrusted: string): Block[] {
  const out: Block[] = [];
  const parts = untrusted.split(/^\[Message (\d+)\]$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1] ?? "";
    const from = /^From: (.*)$/m.exec(body)?.[1] ?? "";
    const at = body.indexOf("\n\n");
    out.push({
      number: Number(parts[i]),
      own: from === "You",
      text: at < 0 ? "" : body.slice(at + 2),
    });
  }
  return out;
}

const DAY_MS = 86_400_000;
/** The text between two marker lines of a request, or "". */
function between(text: string, open: string, close: string): string {
  const start = text.indexOf(`${open}\n`);
  if (start < 0) return "";
  const from = start + open.length + 1;
  const end = text.indexOf(`\n${close}`, from);
  return end < 0 ? "" : text.slice(from, end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function longestWord(text: string): string {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).reduce(
    (best, w) => (w.length > best.length ? w : best),
    "",
  );
}

/** What the demo shortens and swaps. Applied in order; gaps in brackets hold no such words. */
const SHORTER: readonly [RegExp, string][] = [
  [
    /(?<!\p{L})(naprawdę|bardzo|po prostu|właściwie|really|very|just|basically|actually)(?!\p{L}) ?/giu,
    "",
  ],
  [/(?<!\p{L})(chciałbym|chciałabym|I would like to|I wanted to)(?!\p{L}) ?/giu, ""],
  [/(?<!\p{L})w związku z tym(?!\p{L})/giu, "więc"],
];
const FORMAL: readonly [RegExp, string][] = [
  [/^(Cześć|Hej|Witaj|Siema)(?!\p{L}),?/imu, "Dzień dobry,"],
  [/^(Hi|Hey|Hello)(?!\p{L}),?/imu, "Dear Sir or Madam,"],
  [/(Dzięki|Dziękuję) i do usłyszenia,?/giu, "Z poważaniem,"],
  [/^(Pozdrawiam serdecznie|Pozdrawiam|Pozdro),?$/imu, "Z wyrazami szacunku,"],
  [/^(Thanks|Cheers|Best),?$/imu, "Kind regards,"],
  [/(?<!\p{L})dzięki(?!\p{L})/giu, "dziękuję"],
  [/(?<!\p{L})thanks(?!\p{L})/giu, "thank you"],
];
const ENGLISH: readonly [RegExp, string][] = [
  [/Dzień dobry,?/gu, "Hello,"],
  [/(?<!\p{L})(Cześć|Witaj)(?!\p{L}),?/gu, "Hi,"],
  [/Szanowni Państwo,?/gu, "Dear Sir or Madam,"],
  [/dziękuję za wiadomość/giu, "thank you for your message"],
  [/Dziękuję za szybką odpowiedź/giu, "Thank you for the quick reply"],
  [/Odpowiem dokładnie do końca tygodnia/giu, "I will answer in full by the end of the week"],
  [/Potwierdzam otrzymanie dokumentów/giu, "I confirm I received the documents"],
  [/Należność ureguluję/giu, "I will pay the amount due"],
  [/Co do spotkania jutro o dziesiątej:/giu, "About the meeting tomorrow at ten:"],
  [/(?<!\p{L})dziękuję(?!\p{L})/giu, "thank you"],
  [/Pozdrawiam serdecznie,?/gu, "Best regards,"],
  [/Pozdrawiam,?/gu, "Best regards,"],
  [/Z poważaniem,?/gu, "Kind regards,"],
];

interface DemoAsk {
  /** Finds the ask in the other side's message. */
  readonly find: RegExp;
  /** A short phrase for it, as a check names it. */
  readonly about: string;
  /** The draft answers it when this matches. */
  readonly covered: RegExp;
  /** What answering adds: an acknowledgement, or a gap where the decision is the person's. */
  readonly answer: string;
}

/** The asks of the demo mailbox (see seed.ts). */
const ASKS: readonly DemoAsk[] = [
  {
    find: /Czy możemy przesunąć spotkanie na jutro/,
    about: "czy spotkanie można przesunąć na jutro na 10:00",
    covered: /spotkani|jutro|dziesiąt|10:00|meeting|tomorrow/i,
    answer: "Co do spotkania jutro o dziesiątej: [tak / nie].",
  },
  {
    find: /proszę o potwierdzenie otrzymania/,
    about: "potwierdzenie otrzymania dokumentów",
    covered: /otrzyma|dostał|potwierdzam|received|confirm/i,
    answer: "Potwierdzam otrzymanie dokumentów.",
  },
  {
    find: /prosimy o terminowe uregulowanie należności/,
    about: "kiedy zapłacisz należność (termin w piątek)",
    covered: /zapłac|płatnoś|przelew|uregul|pay/i,
    answer: "Należność ureguluję [dzień płatności].",
  },
];

/** Gaps the demo can fill: what the gap's words ask for, and what in a message gives it. */
const GAP_KINDS: readonly { token: RegExp; value: RegExp }[] = [
  { token: /godzin|o której|time|hour/i, value: /na godzinę [\p{L}]+/u },
  {
    token: /dzień|dnia|data|termin|kiedy|date|day|when/i,
    value:
      /(?<!\p{L})(w (poniedziałek|wtorek|środę|czwartek|piątek|sobotę|niedzielę)|jutro|\d{1,2}\.\d{1,2}\.\d{4})(?!\p{L})/u,
  },
  {
    token: /numer zamówienia|zamówieni|order/i,
    value: /\b\d{4}\/\d{2}\/\d{4}\b/,
  },
  { token: /telefon|tel|phone|numer/i, value: /\+48 \d{3} \d{3} \d{3}/ },
  { token: /wagon|miejsce|seat|car/i, value: /wagonie numer [\p{L}]+/u },
  { token: /nocleg|hotel|gdzie|where|miejsc/i, value: /w Zakopanem|w Gdańsku|w centrum Łodzi/u },
];

/**
 * How long a demo turn takes. A real turn takes seconds; with none at all, three turns at once
 * and the screen that shows the reading would pass too fast to be seen or to be tested.
 */
export const DEMO_TURN_MS = 120;

export class DemoAgentRuntime implements AgentRuntimePort {
  readonly id = "claude-code";
  readonly name = "Demo assistant";
  private runs = 0;
  private readonly now: () => number;
  /** Fixed at the start, like a real plan's windows: a reset time that moved would look like a new week. */
  private readonly sessionResetsAtMs: number;
  private readonly weekResetsAtMs: number;

  private readonly turnMs: number;

  constructor(now: () => number = Date.now, turnMs: number = DEMO_TURN_MS) {
    this.now = now;
    this.turnMs = turnMs;
    this.sessionResetsAtMs = now() + 2 * 3_600_000;
    this.weekResetsAtMs = now() + DAY_MS;
  }

  async inspect(): Promise<AgentRuntimeInfo> {
    return {
      id: this.id,
      name: this.name,
      status: "found",
      plan: "demo",
      models: ["haiku", "sonnet", "opus"],
    };
  }

  /** Waits like a turn would; a cancelled turn stops at once, as the real runtime does. */
  private takeTime(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Cancelled."));
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, this.turnMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private limits(): PlanLimits {
    const now = this.now();
    return {
      session: {
        usedPercent: Math.min(60, 5 + this.runs * 0.02),
        resetsAtMs: this.sessionResetsAtMs,
      },
      week: { usedPercent: Math.min(60, 12 + this.runs * 0.01), resetsAtMs: this.weekResetsAtMs },
      usingOverage: false,
      seenAtMs: now,
    };
  }

  async run(
    request: AgentRunRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    this.runs++;
    if (this.turnMs > 0) await this.takeTime(options.signal);
    const props = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    const value =
      "rewritten" in props
        ? this.rewritten(request)
        : "withAnswers" in props
          ? this.withAnswers(request)
          : "asks" in props
            ? this.checked(request)
            : "fills" in props
              ? this.filled(request)
              : this.other(request, props);
    return { value, limits: this.limits(), inputTokens: 1, outputTokens: 1 };
  }

  private other(request: AgentRunRequest, props: Record<string, unknown>): unknown {
    return "title" in props
      ? this.titled(request)
      : "items" in props
        ? this.remembered(request)
        : "trails" in props
          ? this.planned(request)
          : "decision" in props
            ? this.followed(request)
            : "threads" in props
              ? this.talkedAll(request)
              : "quotes" in props
                ? this.talked(request)
                : "edges" in props
                  ? this.blocks(request)
                  : "state" in props
                    ? this.analysis(request)
                    : this.prepared(request);
  }

  // --- Help with a reply (ADR 0098): canned, and true to the rules the code checks ---

  /** The person's draft of a reply helper's request, from its marked part. */
  private draftOf(request: AgentRunRequest): string {
    return between(request.untrusted, DRAFT_OPEN, DRAFT_CLOSE);
  }

  /**
   * Shorter drops filler words, formal swaps casual greetings and closings, English swaps the
   * phrases the demo mailbox uses. Gaps in brackets are never touched.
   */
  private rewritten(request: AgentRunRequest) {
    const draft = this.draftOf(request);
    const swaps = request.instructions.includes(REWRITE_HOW_TEXT.shorter)
      ? SHORTER
      : request.instructions.includes(REWRITE_HOW_TEXT.formal)
        ? FORMAL
        : ENGLISH;
    let out = draft;
    for (const [from, to] of swaps) out = out.replace(from, to);
    out = out
      .replace(/[^\S\n]{2,}/g, " ")
      .replace(/ +([,.!?])/g, "$1")
      .trim();
    return { rewritten: out === "" ? draft : out };
  }

  /** The demo's asks in the newest message from the other side, each with its answer. */
  private asksIn(text: string): DemoAsk[] {
    const found: DemoAsk[] = [];
    for (const ask of ASKS) if (ask.find.test(text)) found.push(ask);
    // Any other line that ends in a question mark is an ask too.
    for (const line of text.split("\n").map((l) => l.trim())) {
      if (!line.endsWith("?") || ASKS.some((a) => a.find.test(line))) continue;
      const about = line.replace(/\?$/, "").slice(0, 100);
      found.push({
        find: /$^/,
        about,
        covered: new RegExp(escapeRegExp(longestWord(line)), "i"),
        answer: `W sprawie pytania „${about}?”: [odpowiedź].`,
      });
    }
    return found.slice(0, 10);
  }

  private checked(request: AgentRunRequest) {
    const message = between(request.untrusted, LAST_OPEN, LAST_CLOSE);
    const draft = this.draftOf(request);
    return {
      asks: this.asksIn(message).map((a) => ({ about: a.about, answered: a.covered.test(draft) })),
    };
  }

  /** Adds a line for every ask the draft leaves open, with a gap where a decision is the person's. */
  private withAnswers(request: AgentRunRequest) {
    const draft = this.draftOf(request);
    const number = /^The last message from the other side is Message (\d+)\.$/m.exec(
      request.untrusted,
    )?.[1];
    const last = blocks(request.untrusted).find((b) => String(b.number) === number);
    // The lines it quotes are older mail, not what it asks now.
    const fresh = (last?.text ?? "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith(">"))
      .join("\n");
    const open = this.asksIn(fresh).filter((a) => !a.covered.test(draft));
    if (open.length === 0) return { withAnswers: draft, added: 0 };
    const lines = open.map((a) => a.answer);
    const at = draft.search(/\n\n(Pozdrawiam|Z poważaniem|Dzięki|Best|Kind regards|Thanks)/i);
    const withAnswers =
      draft.trim() === ""
        ? `Dzień dobry,\n\n${lines.join("\n\n")}\n\nPozdrawiam`
        : at < 0
          ? `${draft}\n\n${lines.join("\n\n")}`
          : `${draft.slice(0, at)}\n\n${lines.join("\n\n")}${draft.slice(at)}`;
    return { withAnswers, added: open.length };
  }

  /** For each gap, the first passage of the thread its words point to, copied exactly. */
  private filled(request: AgentRunRequest) {
    const tokens = between(request.untrusted, GAPS_OPEN, GAPS_CLOSE)
      .split("\n")
      .filter((t) => draftGaps(t).length > 0);
    const messages = blocks(request.untrusted);
    const fills: { token: string; message: number; value: string }[] = [];
    for (const token of tokens) {
      const kind = GAP_KINDS.find((k) => k.token.test(token));
      if (kind === undefined) continue;
      for (const block of [...messages].reverse()) {
        const value = kind.value.exec(block.text)?.[0]?.trim();
        if (value === undefined || value === "") continue;
        fills.push({ token, message: block.number, value });
        break;
      }
    }
    return { fills };
  }

  /** A talk across all mail is named after the first words of its first question (ADR 0086). */
  private titled(request: AgentRunRequest) {
    const first = /^1\. (.*)$/m.exec(request.untrusted)?.[1] ?? "Your mail";
    const words = first
      .replace(/[?!.,]+/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    const name = words.join(" ");
    return { title: `${name.charAt(0).toUpperCase()}${name.slice(1)}` || "Your mail" };
  }

  /** A payment holds up everything else on the cards: enough to see a map in a demo. */
  private blocks(request: AgentRunRequest) {
    const cards = request.untrusted.split(/^\[Card \d+\]$/m).slice(1);
    const at = cards.findIndex((c) => c.includes("Termin płatności"));
    const quote = /"([^"]*Termin płatności[^"]*)"/.exec(cards[at] ?? "")?.[1];
    if (at < 0 || quote === undefined) return { edges: [] };
    const edges = cards.flatMap((_, i) =>
      i === at ? [] : [{ blocker: at + 1, blocked: i + 1, quote }],
    );
    return { edges };
  }

  private analysis(request: AgentRunRequest) {
    const facts: { kind: string; who: string; message: number; quote: string }[] = [];
    let headline = "Nothing is open";
    let stakes: "none" | "money" | "contract" = "none";
    let cost = "";
    for (const block of blocks(request.untrusted)) {
      for (const rule of RULES) {
        if (rule.author !== (block.own ? "you" : "them") || !block.text.includes(rule.find))
          continue;
        if (facts.some((f) => f.quote === rule.find)) continue;
        if (facts.length === 0) headline = rule.headline;
        if (rule.stakes !== undefined) {
          stakes = rule.stakes;
          cost = rule.find;
        }
        facts.push({ kind: rule.kind, who: rule.who, message: block.number, quote: rule.find });
        break;
      }
    }
    const state = facts.some((f) => f.who === "you")
      ? "onYou"
      : facts.some((f) => f.who === "them")
        ? "waiting"
        : "fyi";
    const numbers = [...request.untrusted.matchAll(/\b\d{2,4}\/\d{4}\b/g)].map((m) => m[0]);
    return {
      state,
      headline,
      facts: facts.slice(0, 3),
      stakes,
      confidence: 0.9,
      consequence: cost === "" ? "minor" : "real",
      ...(cost === "" ? {} : { consequenceQuote: cost }),
      case: numbers[0] === undefined ? "" : `Faktura ${numbers[0]}`,
      anchors: [...new Set(numbers)].slice(0, 6),
      // What the thread asks of the person (ADR 0066): the demo asks nothing beyond the facts.
      intent: state === "onYou" ? "reply" : state === "waiting" ? "wait" : "none",
      intentQuote: facts[0]?.quote ?? "",
      forYou: "generic",
      status: "open",
      category: "other",
    };
  }

  /** The turn that keeps what the person typed: its request holds their words and nothing else. */
  private remembered(request: AgentRunRequest) {
    const words = request.untrusted;
    if (/wszystko od|everything from/i.test(words)) return { items: [{ scope: "sender" }] };
    if (/zawsze|always/i.test(words)) {
      return {
        items: [{ scope: "write", text: words.replace(/^The person typed:\n/, "").trim() }],
      };
    }
    return { items: [] };
  }

  /** The person's own words of the turn, from their marked part of the request. */
  private wordsOf(request: AgentRunRequest): string {
    return (
      /^=== The person's words now\..*===\n([\s\S]*?)\n=== End of the person's words ===$/m.exec(
        request.untrusted,
      )?.[1] ?? ""
    );
  }

  /** The plan turn: one trail with the longest word of the person's words, and a state for waiting. */
  private planned(request: AgentRunRequest) {
    const words = this.wordsOf(request);
    const longest = (words.match(/[\p{L}\p{N}]+/gu) ?? []).reduce(
      (best, w) => (w.length > best.length ? w : best),
      "",
    );
    return {
      goal: words.slice(0, 200) || "Nothing was asked",
      followsUp: /^\s*(and|a |i )/i.test(words),
      time: /\b(all|every|wszystk)/i.test(words) ? "any" : "recent",
      assumptions: [],
      trails:
        longest === ""
          ? []
          : [
              {
                name: "The word",
                why: "It is the longest word asked.",
                priority: 5,
                queries: [longest],
              },
            ],
      traps: [],
      ...(/waiting|czeka/i.test(words) ? { state: "onYou" } : {}),
    };
  }

  /** A follow turn: it keeps every thread listed, the newest first, and answers. */
  private followed(request: AgentRunRequest) {
    const found: { number: number; day: string }[] = [];
    const parts = request.untrusted.split(/^\[Thread (\d+)\][^\n]*$/m);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const day = /^Newest: (\S+)/m.exec(parts[i + 1] ?? "")?.[1];
      if (day !== undefined) found.push({ number: Number(parts[i]), day });
    }
    found.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.number - b.number));
    return {
      decision: "answer",
      keep: found.slice(0, 20).map((f) => f.number),
      hypothesis: "The newest threads that matched the word are the ones.",
    };
  }

  /** The answer turn across threads: the first thread, with one line of it as the quote. */
  private talkedAll(request: AgentRunRequest) {
    const first = request.untrusted.split(/^\[Thread \d+\]$/m)[1] ?? "";
    for (const block of blocks(first)) {
      const line = block.text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length >= 8 && !l.startsWith(">"));
      if (line !== undefined) {
        return {
          text: "This is what the newest thread says.",
          threads: [
            {
              thread: 1,
              note: "The newest thread that matched.",
              quotes: [{ message: block.number, quote: line.slice(0, 120) }],
            },
          ],
        };
      }
    }
    return { text: "I found nothing in these threads to quote.", threads: [] };
  }

  /**
   * A turn of the talk about a thread. What it does is read from the person's words in the request
   * (their own part, never the mail's); an answer quotes a line of the numbered message it was
   * handed, so the check of quotes runs for real.
   */
  private talked(request: AgentRunRequest) {
    const words =
      /^=== The person's words now\..*===\n([\s\S]*?)\n=== End of the person's words ===$/m.exec(
        request.untrusted,
      )?.[1] ?? "";
    // Checked first: "no reply" holds the word reply.
    if (/done|załatwione|no reply/i.test(words)) {
      return { kind: "closed", reason: "Nothing more to do here, as you said." };
    }
    if (/\d|write|reply|odpisz/i.test(words)) {
      return {
        kind: "draft",
        body: "Dzień dobry,\n\ndziękuję za wiadomość. Odpowiem dokładnie do końca tygodnia.\n\nPozdrawiam",
        nudge: false,
      };
    }
    for (const block of [...blocks(request.untrusted)].reverse()) {
      const line = block.text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length >= 8 && !l.startsWith(">"));
      if (line !== undefined) {
        return {
          kind: "answer",
          text: "This is what the latest message says.",
          quotes: [{ message: block.number, quote: line.slice(0, 120) }],
        };
      }
    }
    return { kind: "answer", text: "I found nothing in this thread to quote.", quotes: [] };
  }

  private prepared(request: AgentRunRequest) {
    const text = request.untrusted;
    const words = /^In their own words: (.*)$/m.exec(text)?.[1];
    const direction = /^Direction: (.*)$/m.exec(text)?.[1];
    if (words !== undefined && /no reply|don't write|nie odpisuj|nie pisz/i.test(words)) {
      return { kind: "closed", reason: "Nothing to answer here, as you said." };
    }
    if (words !== undefined || direction !== undefined) {
      return {
        kind: "draft",
        body: `Dzień dobry,\n\n${words ?? direction}\n\nPozdrawiam`,
        nudge: false,
      };
    }
    if (text.includes("płatności")) {
      return {
        kind: "needs",
        missing: "Brakuje kwoty i terminu, które mogę potwierdzić.",
        directions: ["Poproś o numer rachunku", "Napisz, kiedy zapłacisz"],
      };
    }
    return {
      kind: "draft",
      body: "Dzień dobry,\n\ndziękuję za wiadomość. Odpowiem dokładnie do końca tygodnia.\n\nPozdrawiam",
      nudge: text.includes("State: waiting"),
    };
  }
}
