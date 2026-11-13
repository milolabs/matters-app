// A runtime that answers from canned facts, for a run with no model (MATTERS_SEED=1): the app
// can be seen and smoke-tested over the demo mailbox without the person's plan, a program or a
// network. Every quote it gives is a passage it found in the text it was handed, so the code that
// holds quotes to the mail (ADR 0051, rule 9) is exercised for real. It exists only when the sync
// worker was started with the seed (see syncWorker.ts); a real database never gets one.
import type {
  AgentEffort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  PlanLimits,
} from "@matters/core";
import {
  AGENT_EFFORTS,
  ASKED_CLOSE,
  ASKED_OPEN,
  DRAFT_CLOSE,
  DRAFT_OPEN,
  draftGaps,
  GAPS_CLOSE,
  GAPS_OPEN,
  LAST_CLOSE,
  LAST_OPEN,
  PROMPT_CLOSE,
  PROMPT_OPEN,
  REWRITE_HOW_TEXT,
} from "@matters/core";

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
/** Words of a prompt that say nothing about mail (ADR 0116): the demo does not match on them. */
const PROMPT_STOP_WORDS = new Set([
  "what",
  "that",
  "this",
  "with",
  "from",
  "have",
  "only",
  "would",
]);
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
  /** The effort each turn asked for, in order; `undefined` when it asked for none (ADR 0118). */
  readonly effortsAsked: (AgentEffort | undefined)[] = [];
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
      efforts: [...AGENT_EFFORTS],
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
    this.effortsAsked.push(request.effort);
    if (this.turnMs > 0) await this.takeTime(options.signal);
    const props = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    const value =
      "verdicts" in props
        ? this.judged(request)
        : "rewritten" in props
          ? this.rewritten(request)
          : "written" in props
            ? this.written(request)
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
                : this.prepared(request);
  }

  // --- A prompt is a filter (ADR 0116): the same answer for the same mail, every time ---

  /**
   * A batch of threads against the person's prompt, by the lines that hold a word of the prompt:
   * two different passages fit 2, and 3 when there are five lines; one passage fits 2 when it
   * comes up three times, else 1 (stored and not shown); none is 0. It quotes the first. The reason names the message and the word, so
   * it differs from thread to thread. Every quote is a line of the message it names.
   */
  private judged(request: AgentRunRequest) {
    const prompt = between(request.untrusted, PROMPT_OPEN, PROMPT_CLOSE);
    const words = (prompt.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(
      (w) => !PROMPT_STOP_WORDS.has(w),
    );
    const parts = request.untrusted.split(/^\[Thread (\d+)\]$/m);
    const verdicts = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const body = parts[i + 1] ?? "";
      const lines = blocks(body).flatMap((b) =>
        b.text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length >= 8 && !l.startsWith(">"))
          .map((line) => ({ message: b.number, line })),
      );
      const hits = lines.filter(({ line }) => words.some((w) => line.toLowerCase().includes(w)));
      const first = hits[0];
      if (first === undefined) {
        verdicts.push({
          thread: Number(parts[i]),
          fit: 0,
          why: "Nothing in it holds what the prompt asks for.",
        });
        continue;
      }
      const word = words.find((w) => first.line.toLowerCase().includes(w)) ?? "";
      // Mail repeats itself: a sentence quoted again counts once toward a strong fit.
      const distinct = new Set(hits.map((h) => h.line)).size;
      const fit = distinct >= 2 ? (hits.length >= 5 ? 3 : 2) : hits.length >= 3 ? 2 : 1;
      const why =
        fit === 3
          ? `“${word}” runs through it: ${hits.length} lines, from message ${first.message} on.`
          : fit === 2 && distinct >= 2
            ? `“${word}” in message ${first.message}, and another passage says more.`
            : fit === 2
              ? `“${word}” comes up ${hits.length} times, first in message ${first.message}.`
              : `Only message ${first.message} names “${word}”, in passing.`;
      verdicts.push({
        thread: Number(parts[i]),
        fit,
        why,
        message: first.message,
        quote: first.line.slice(0, 120),
      });
    }
    return { verdicts };
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

  /**
   * Writes as the person asked (ADR 0132): a line made from their words, with gaps for the date
   * and the time it was not given, put above the closing of the draft, or a short message around
   * it when the draft is empty. The draft's own lines and gaps are kept as they are.
   */
  private written(request: AgentRunRequest) {
    const asked = between(request.untrusted, ASKED_OPEN, ASKED_CLOSE)
      .replace(/^(please\s+)?(write|add|make|draft)\s+/i, "")
      .replace(/[\s.!?]+$/, "");
    const draft = this.draftOf(request).trim();
    const line = `About ${asked}: on [date], at [time].`;
    if (draft === "") return { written: `Hello,\n\n${line}\n\nBest regards,` };
    const at = draft.search(/\n\n(Pozdrawiam|Z poważaniem|Dzięki|Best|Kind regards|Thanks)/i);
    return {
      written:
        at < 0 ? `${draft}\n\n${line}` : `${draft.slice(0, at)}\n\n${line}${draft.slice(at)}`,
    };
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
      nudge: false,
    };
  }
}
