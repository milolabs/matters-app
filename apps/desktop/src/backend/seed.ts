import type {
  AccountStorePort,
  AttachmentAnswer,
  IngestDeps,
  Label,
  Message,
  MessageDocument,
  MessageStorePort,
  Participant,
  SavedViewStorePort,
} from "@matters/core";
import { ingestDocuments, messageKey, writeDocuments } from "@matters/core";
import {
  DEMO_HOST,
  DEMO_MESSAGES,
  demoLocation,
  demoStoredName,
  FIRST_FILE_PART,
} from "./demoMail.ts";

// Deterministic synthetic mailbox with Polish text, so diacritics hit search and rendering.

export const ME: Participant = { name: "Miłosz Sobczak", address: "milosz@example.com" };
export const ACCOUNT_ID = "acc1";
/** Fixed "now" of the seed, so every run produces the same mailbox. */
export const SEED_NOW_MS = Date.UTC(2026, 10, 3, 9, 30);

const DAY = 86_400_000;

const SENDERS: readonly Participant[] = [
  { name: "Agnieszka Wiśniewska", address: "agnieszka.wisniewska@example.pl" },
  { name: "Łukasz Żółkiewski", address: "lukasz.zolkiewski@example.pl" },
  { name: "Małgorzata Dąbrowska", address: "m.dabrowska@example.pl" },
  { name: "Józef Kołodziej", address: "jozef.kolodziej@example.pl" },
  { name: "Świetlana Ćwik", address: "swietlana.cwik@example.pl" },
  { name: "Błażej Mazur", address: "blazej.mazur@example.pl" },
  { name: "Ewa Kaźmierczak", address: "ewa.kazmierczak@example.pl" },
  { name: "Michał Górski", address: "michal.gorski@example.pl" },
  { name: "Żaneta Szymańska", address: "zaneta.szymanska@example.pl" },
  { name: "Paweł Zieliński", address: "pawel.zielinski@example.pl" },
  { name: "PKP Intercity", address: "bilet@pkp-intercity.example.pl" },
  { name: "Księgowość Biuro Rachunkowe", address: "ksiegowosc@biuro.example.pl" },
  { name: "Przychodnia Zdrowie", address: "rejestracja@przychodnia.example.pl" },
  { name: "Sklep Łąka", address: "zamowienia@sklep-laka.example.pl" },
];

interface Topic {
  readonly subjects: readonly string[];
  readonly label?: string;
  readonly attachment?: boolean;
}

const TOPICS: readonly Topic[] = [
  {
    label: "faktury",
    attachment: true,
    subjects: [
      "Faktura nr {n}/2026 za październik",
      "Faktura VAT {n} do zapłaty do końca miesiąca",
      "Rozliczenie kwartalne: zażółć dokumenty",
    ],
  },
  {
    label: "praca",
    subjects: [
      "Zaproszenie na spotkanie: przegląd kwartalny",
      "Notatki z warsztatów: planowanie sprintu",
      "Wycena projektu strony: wersja {n}",
      "Prośba o przegląd kodu: moduł płatności",
    ],
  },
  {
    label: "podroze",
    attachment: true,
    subjects: [
      "Bilet PKP Intercity: Warszawa → Kraków",
      "Rezerwacja hotelu w Gdańsku potwierdzona",
      "Plan wyjazdu w góry: Zakopane, Łysa Polana",
    ],
  },
  {
    subjects: [
      "Przypomnienie: wizyta u dentysty w czwartek",
      "Zamówienie {n} zostało wysłane",
      "Urodziny Józka: gdzie świętujemy?",
      "Pytanie o mieszkanie przy ul. Łąkowej",
      "Zażółć gęślą jaźń: test czcionki",
      "Co słychać? Dawno się nie odzywałeś",
    ],
  },
];

const SENTENCES: readonly string[] = [
  "Dzień dobry, piszę w sprawie, o której rozmawialiśmy w zeszłym tygodniu.",
  "Załączam wszystkie potrzebne dokumenty, proszę o potwierdzenie otrzymania.",
  "Czy możemy przesunąć spotkanie na jutro, na godzinę dziesiątą?",
  "Dziękuję za szybką odpowiedź, wszystko jest już jasne.",
  "Płatność została zaksięgowana, zażółcona kartka z podsumowaniem w załączniku.",
  "Proszę o kontakt, jeśli pojawią się jakiekolwiek pytania lub wątpliwości.",
  "Wyjazd planujemy na przełomie miesiąca, nocleg w Zakopanem jest już zarezerwowany.",
  "Przesyłam poprawioną wersję, uwzględniłem uwagi z ostatniego przeglądu.",
  "Łączę się z Państwem jeszcze dziś po południu, aby omówić szczegóły.",
  "Pozdrawiam serdecznie i życzę udanego tygodnia.",
  "Termin płatności upływa w piątek, prosimy o terminowe uregulowanie należności.",
  "Bilet jest ważny w dniu podróży, miejsce w wagonie numer sześć.",
  "Zgodnie z ustaleniami wysyłam harmonogram prac na kolejny kwartał.",
  "Chętnie spotkam się na kawę, najlepiej gdzieś w centrum Łodzi.",
];

const GREETINGS: readonly string[] = ["Dzień dobry,", "Cześć,", "Witaj,", "Szanowni Państwo,"];
const CLOSINGS: readonly string[] = [
  "Pozdrawiam serdecznie,",
  "Z poważaniem,",
  "Dzięki i do usłyszenia,",
  "Łączę wyrazy szacunku,",
];

const two = (n: number) => String(n).padStart(2, "0");

/** "2026-11-03 09:30" in UTC, enough for a quote header. */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** Quote like a mail client: every line, blank ones included, gets a `> ` prefix. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");
}

/** mulberry32: small, fast, seedable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedOptions {
  readonly messages?: number;
  readonly threads?: number;
  readonly seed?: number;
}

export function generateMailbox(options: SeedOptions = {}): MessageDocument[] {
  const messageCount = options.messages ?? 8000;
  const threadCount = options.threads ?? 2000;
  const rand = rng(options.seed ?? 1);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  // Every thread gets one message; the rest land on random threads (about 4 per thread).
  const sizes = new Array<number>(threadCount).fill(1);
  for (let i = threadCount; i < messageCount; i++) {
    const t = Math.floor(rand() * threadCount);
    sizes[t] = (sizes[t] ?? 1) + 1;
  }

  const nextSeq = new Map<number, number>();
  const docs: MessageDocument[] = [];

  for (let t = 0; t < threadCount; t++) {
    const topic = pick(TOPICS);
    const peer = pick(SENDERS);
    const subject = pick(topic.subjects).replace("{n}", String(100 + Math.floor(rand() * 900)));
    // Squared: more threads near the present, a long tail over ~2 years.
    let dateMs = SEED_NOW_MS - Math.floor(rand() ** 2 * 700 * DAY) - Math.floor(rand() * DAY);

    let lastBody: { text: string; dateMs: number; who: string } | undefined;

    for (let i = 0; i < (sizes[t] ?? 1); i++) {
      dateMs = Math.min(dateMs + 300_000 + Math.floor(rand() * 2 * DAY), SEED_NOW_MS - 60_000);
      const seq = nextSeq.get(dateMs) ?? 0;
      nextSeq.set(dateMs, seq + 1);

      const fromMe = i % 2 === 1;
      const author = fromMe ? ME : peer;
      const paragraphs = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(SENTENCES)).join(" "),
      );
      const fresh = [
        pick(GREETINGS),
        ...paragraphs,
        pick(CLOSINGS),
        `-- \n${author.name}\ntel. +48 ${500 + Math.floor(rand() * 400)} ${100 + Math.floor(rand() * 900)} ${100 + Math.floor(rand() * 900)}`,
      ].join("\n\n");
      // Replies carry the whole previous message, itself quoted, below the new text.
      const previous = lastBody;
      const body =
        i > 0 && previous
          ? `${fresh}\n\nW dniu ${stamp(previous.dateMs)} ${previous.who} napisał(a):\n${quote(previous.text)}`
          : fresh;
      lastBody = { text: body, dateMs, who: `${author.name} <${author.address}>` };
      const recent = SEED_NOW_MS - dateMs < 14 * DAY;
      const labelIds = [fromMe ? "sent" : "inbox", ...(topic.label ? [topic.label] : [])];
      const providerId = `seed-${t}-${i}`;
      const message: Message = {
        key: messageKey(dateMs, seq),
        accountId: ACCOUNT_ID,
        providerId,
        threadId: `thread-${t}`,
        messageIdHeader: `<${providerId}@seed.example>`,
        dateMs,
        from: fromMe ? ME : peer,
        to: [fromMe ? peer : ME],
        cc: [],
        subject: i === 0 ? subject : `Re: ${subject}`,
        snippet: (paragraphs[0] ?? "").slice(0, 140),
        flags: {
          seen: fromMe || rand() < (recent ? 0.4 : 0.97),
          flagged: rand() < 0.03,
          answered: !fromMe && i + 1 < (sizes[t] ?? 1),
          draft: false,
        },
        labelIds,
        hasAttachments: topic.attachment === true && i === 0,
        senderAuth: "unknown",
        replyTo: [],
      };
      docs.push({ message, bodyText: body });
    }
  }
  return docs;
}

const SEED_BATCH = 1000;

/**
 * Fills an empty store with the deterministic mailbox through the same path sync will use.
 * Returns the number of messages written (0 when the store already has mail).
 */
export async function seedIfEmpty(deps: IngestDeps, options: SeedOptions = {}): Promise<number> {
  if ((await deps.store.listNewest({ limit: 1 })).length > 0) return 0;
  const documents = generateMailbox(options);
  for (let i = 0; i < documents.length; i += SEED_BATCH) {
    await ingestDocuments(deps, documents.slice(i, i + SEED_BATCH));
  }
  return documents.length;
}

const DEMO_IMAGE = '<img src="https://images.demo.invalid/hero.png" alt="Hero" width="560">';
const DEMO_PIXEL = '<img src="https://track.demo.invalid/open.gif" width="1" height="1" alt="">';

/** One designed mail for each state of the image bar (ADR 0037). */
const IMAGE_DEMOS: readonly {
  readonly from: Participant;
  readonly subject: string;
  readonly senderAuth: Message["senderAuth"];
  readonly images: string;
  /** Where the sender asked for answers (ADR 0042); none when absent. */
  readonly replyTo?: readonly Participant[];
}[] = [
  {
    from: { name: "Sklep Łąka", address: "newsletter@sklep-laka.example" },
    subject: "Zdjęcia: nadawca zweryfikowany",
    senderAuth: "pass",
    images: DEMO_IMAGE + DEMO_PIXEL,
  },
  {
    from: { name: "Gazetka", address: "wydanie@gazetka.example" },
    subject: "Zdjęcia: brak wyniku weryfikacji",
    senderAuth: "unknown",
    images: DEMO_IMAGE,
    // A reply goes to the editors, not to the sender's system address: the line shows it.
    replyTo: [{ name: "Redakcja", address: "redakcja@gazetka.example" }],
  },
  {
    from: { name: "Dostawca", address: "faktury@dostawca.example" },
    subject: "Zdjęcia: weryfikacja nieudana",
    senderAuth: "fail",
    images: DEMO_IMAGE,
    // Unverified sender and answers asked for elsewhere: the line turns to a warning.
    replyTo: [{ address: "rozliczenia@dostawca-faktury.example" }],
  },
  {
    from: { name: "Ania", address: "ania.przyklad@gmail.com" },
    subject: "Zdjęcia: publiczna skrzynka",
    senderAuth: "pass",
    images: DEMO_IMAGE,
  },
  {
    from: { name: "Serwis", address: "powiadomienia@serwis.example" },
    subject: "Zdjęcia: tylko piksel śledzący",
    senderAuth: "pass",
    images: DEMO_PIXEL,
  },
];

/**
 * The newest mail of a demo run, so the states are at hand; generated mail stops a minute earlier.
 * Apart from the generated mailbox: the smoke and the benchmarks measure opening plain letters.
 */
export function seedImageDemo(deps: IngestDeps): Promise<unknown> {
  return ingestDocuments(deps, imageDemoMail());
}

export function imageDemoMail(): MessageDocument[] {
  return IMAGE_DEMOS.map((demo, i) => {
    const dateMs = SEED_NOW_MS - (i + 1) * 1000;
    const providerId = `seed-images-${i}`;
    const text = `${demo.subject}. Treść listu do pokazania stanów paska.`;
    return {
      message: {
        key: messageKey(dateMs, 0),
        accountId: ACCOUNT_ID,
        providerId,
        threadId: `thread-images-${i}`,
        messageIdHeader: `<${providerId}@seed.example>`,
        dateMs,
        from: demo.from,
        to: [ME],
        cc: [],
        subject: demo.subject,
        snippet: text,
        flags: { seen: false, flagged: false, answered: false, draft: false },
        labelIds: ["inbox"],
        hasAttachments: false,
        senderAuth: demo.senderAuth,
        replyTo: demo.replyTo ?? [],
      },
      bodyText: text,
      bodyHtml: `<table width="600"><tr><td>${demo.images}<p>${text}</p></td></tr></table>`,
      htmlKind: "designed",
    };
  });
}

/**
 * Demo messages with files, with real attachment rows and a place on the demo server, so that
 * every state of the strip can be reached (ADR 0043): one file, many files, odd names, a runnable
 * one, a large one, one that fails once and one that is gone. They are read like synced mail: the
 * rows say what the structure said, and a download is answered by `DemoMail`.
 */
export async function seedAttachmentDemo(deps: IngestDeps): Promise<void> {
  const documents = attachmentDemoMail();
  await deps.uow.run(async () => {
    const written = await writeDocuments(deps, documents);
    await deps.store.addLocations(
      DEMO_MESSAGES.map((m, i) => ({
        key: written.keys[i] as number,
        location: demoLocation(m.uid),
      })),
    );
    const answers: AttachmentAnswer[] = DEMO_MESSAGES.map((m) => ({
      location: demoLocation(m.uid),
      attachments: m.files.map((f, i) => ({
        partId: String(i + FIRST_FILE_PART),
        name: demoStoredName(f),
        mimeType: f.mimeType,
        size: f.size,
        inline: false,
      })),
    }));
    await deps.store.setAttachments(answers);
  });
}

export function attachmentDemoMail(): MessageDocument[] {
  return DEMO_MESSAGES.map((demo, i) => {
    const dateMs = SEED_NOW_MS - (i + 10) * 1000;
    const providerId = `seed-files-${i}`;
    return {
      message: {
        key: messageKey(dateMs, 0),
        accountId: ACCOUNT_ID,
        providerId,
        threadId: `thread-files-${i}`,
        messageIdHeader: `<${providerId}@seed.example>`,
        dateMs,
        from: demo.from,
        to: [ME],
        cc: [],
        subject: demo.subject,
        snippet: demo.text,
        flags: { seen: false, flagged: false, answered: false, draft: false },
        labelIds: ["inbox"],
        hasAttachments: true,
        senderAuth: "unknown",
        replyTo: [],
      },
      bodyText: demo.text,
      ...(demo.html === undefined ? {} : { bodyHtml: demo.html, htmlKind: "designed" as const }),
    };
  });
}

/**
 * The account the demo mail belongs to, so a demo run can reply and compose. It points nowhere
 * (plaintext is refused without the test opt-in, so it never connects) and has no password.
 */
export async function seedDemoAccount(accounts: AccountStorePort): Promise<void> {
  if (await accounts.get(ACCOUNT_ID)) return;
  await accounts.add({
    id: ACCOUNT_ID,
    address: ME.address,
    displayName: ME.name ?? ME.address,
    imap: { host: DEMO_HOST, port: 143, security: "none", username: ME.address },
    smtp: { host: "smtp.demo.invalid", port: 25, security: "none", username: ME.address },
    createdAtMs: SEED_NOW_MS,
  });
}

/** Tabs for the demo, after the starter views every database has (ADR 0029). */
export async function seedDemoViews(views: SavedViewStorePort): Promise<void> {
  const demo = [
    ["Invoices", "faktura has:attachment"],
    ["Work", "label:praca"],
  ] as const;
  const first = (await views.list()).length;
  for (const [i, [name, query]] of demo.entries()) {
    await views.put({
      id: `demo-view-${i + 1}`,
      name,
      query,
      position: first + i,
      createdMs: SEED_NOW_MS,
      updatedMs: SEED_NOW_MS,
    });
  }
}

/**
 * What the demo mail's labels are (ADR 0044): the seed names its places `inbox` and `sent` and
 * tags the rest, so those are the folder ids. Without a server there is no sync to list them, and
 * the Move list and the roles that hide Trash and Spam need them.
 */
export const DEMO_FOLDERS: readonly Label[] = [
  ["inbox", "Inbox", "inbox"],
  ["sent", "Sent", "sent"],
  ["drafts", "Drafts", "drafts"],
  ["trash", "Trash", "trash"],
  ["spam", "Spam", "spam"],
  ["archive", "Archive", "archive"],
  ["faktury", "Faktury", "other"],
  ["praca", "Praca", "other"],
  ["podroze", "Podróże", "other"],
].map(([id, name, role]) => ({
  id: id as string,
  accountId: ACCOUNT_ID,
  name: name as string,
  role: role as Label["role"],
  exclusive: true,
}));

/** Written at every start: folders are listed by sync in a real run, and this stands for it. */
export async function seedDemoFolders(store: Pick<MessageStorePort, "setFolders">): Promise<void> {
  await store.setFolders(ACCOUNT_ID, DEMO_FOLDERS);
}

/**
 * Mail in Trash and Spam, and a thread with one message in each of Inbox and Trash, so that what
 * ADR 0044 hides can be seen to be hidden and found with `in:trash` and `in:spam`. Apart from the
 * generated mailbox, like the other demo mail.
 */
export function seedMoveDemo(deps: IngestDeps): Promise<unknown> {
  return ingestDocuments(deps, moveDemoMail());
}

const MOVE_DEMOS: readonly {
  readonly id: string;
  readonly thread: string;
  readonly from: Participant;
  readonly subject: string;
  readonly labels: readonly string[];
}[] = [
  {
    id: "trash-1",
    thread: "trash-1",
    from: { name: "Sklep Łąka", address: "zamowienia@sklep-laka.example.pl" },
    subject: "Do kosza: stare zamówienie",
    labels: ["trash"],
  },
  {
    id: "trash-2",
    thread: "trash-2",
    from: { name: "Józef Kołodziej", address: "jozef.kolodziej@example.pl" },
    subject: "Do kosza: nieaktualne zaproszenie",
    labels: ["trash"],
  },
  {
    id: "mixed-1",
    thread: "mixed",
    from: { name: "Ewa Kaźmierczak", address: "ewa.kazmierczak@example.pl" },
    subject: "Wątek z jednym listem w koszu",
    labels: ["inbox"],
  },
  {
    id: "mixed-2",
    thread: "mixed",
    from: { name: "Ewa Kaźmierczak", address: "ewa.kazmierczak@example.pl" },
    subject: "Re: Wątek z jednym listem w koszu",
    labels: ["trash"],
  },
  {
    id: "spam-1",
    thread: "spam-1",
    from: { name: "Nagroda", address: "wygrana@loteria.example" },
    subject: "Spam: wygrałeś milion złotych",
    labels: ["spam"],
  },
  {
    id: "spam-2",
    thread: "spam-2",
    from: { name: "Apteka", address: "tanie@leki.example" },
    subject: "Spam: tanie leki bez recepty",
    labels: ["spam"],
  },
];

export function moveDemoMail(): MessageDocument[] {
  return MOVE_DEMOS.map((demo, i) => {
    const dateMs = SEED_NOW_MS - (i + 20) * 1000;
    const providerId = `seed-moves-${demo.id}`;
    const text = `${demo.subject}. List do poćwiczenia przenoszenia.`;
    return {
      message: {
        key: messageKey(dateMs, 0),
        accountId: ACCOUNT_ID,
        providerId,
        threadId: `thread-moves-${demo.thread}`,
        messageIdHeader: `<${providerId}@seed.example>`,
        dateMs,
        from: demo.from,
        to: [ME],
        cc: [],
        subject: demo.subject,
        snippet: text,
        flags: { seen: false, flagged: false, answered: false, draft: false },
        labelIds: demo.labels,
        hasAttachments: false,
        senderAuth: "unknown",
        replyTo: [],
      },
      bodyText: text,
    };
  });
}
