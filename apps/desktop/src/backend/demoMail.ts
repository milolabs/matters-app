// Demo mail with files, for a run that has no server (MATTERS_SEED=1). The seed writes these
// messages with real attachment rows, and `DemoMail` answers a download with bytes it makes up,
// behind the same `MailAttachmentPort` the IMAP adapter implements, so the whole flow of ADR 0043
// (press, ring, open, save, offline, gone) can be driven without a network. It exists only when
// the sync worker was started with the seed; nothing else ever constructs it.
import type {
  DownloadConnection,
  MessageLocation,
  PartDownload,
  Participant,
  StoredAccount,
} from "@matters/core";
import { safeFileName } from "@matters/core";

export const DEMO_HOST = "imap.demo.invalid";
const DEMO_ACCOUNT_ID = "acc1";
/** In the demo's imagined structure the letter is part 1 and the first file is part 2. */
export const FIRST_FILE_PART = 2;
const KB = 1000;
const MB = 1_000_000;

/** How a demo file answers when it is asked for. */
type Behaviour =
  /** Bytes arrive, at once for a small file and over a few seconds for a large one. */
  | "ok"
  /** The first try finds no network, the second works: "Try again" can be driven. */
  | "offlineOnce"
  /** The server no longer has the message. */
  | "gone";

export interface DemoFile {
  /** As the sender wrote it; the seed stores it through `safeFileName` like sync does. */
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly behaviour?: Behaviour;
}

export interface DemoMessage {
  readonly uid: number;
  readonly from: Participant;
  readonly subject: string;
  readonly text: string;
  readonly files: readonly DemoFile[];
  /** A designed layout, shown as sent; a forward leaves it behind (ADR 0045, rule 12). */
  readonly html?: string;
}

/** Long enough that the middle of the name has to give way and the extension must not. */
const LONG_NAME =
  "Zestawienie kosztów projektu budowlanego etap drugi wersja ostateczna po uwagach Kowalskiego i Nowak (poprawione 28.10.2026).xlsx";

export const DEMO_MESSAGES: readonly DemoMessage[] = [
  {
    uid: 9001,
    from: { name: "Księgowość Biuro Rachunkowe", address: "ksiegowosc@biuro.example.pl" },
    subject: "Załączniki: jeden plik",
    text: "Dzień dobry, w załączeniu faktura za październik.",
    files: [{ name: "Faktura FV 2026-10-0417.pdf", mimeType: "application/pdf", size: 212 * KB }],
  },
  {
    uid: 9002,
    from: { name: "Agnieszka Wiśniewska", address: "agnieszka.wisniewska@example.pl" },
    subject: "Załączniki: dużo plików i dziwne nazwy",
    text: "Wszystko, o co prosiłeś, w jednej wiadomości. Nazwy są, jakie są.",
    files: [
      { name: LONG_NAME, mimeType: "application/vnd.ms-excel", size: 1_480 * KB },
      {
        name: "Zażółć gęślą jaźń — notatki ze spotkania.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 58 * KB,
      },
      // A script that would run on a double click: Open is refused, Save and Preview are not.
      { name: "Instalator.command", mimeType: "application/octet-stream", size: 2 * KB },
      // Right-to-left override: the name below reads as a PDF and is not. It is shown as written
      // without the override, which is what `safeFileName` makes of it.
      { name: "faktura\u202egpj.exe", mimeType: "application/octet-stream", size: 640 * KB },
      { name: "zdjęcie z wakacji.jpg", mimeType: "image/jpeg", size: 3_100 * KB },
      { name: "Nagranie ze spotkania zespołu.mp3", mimeType: "audio/mpeg", size: 9 * MB },
      { name: "../../.zshrc", mimeType: "text/plain", size: 900 },
      { name: "Plan wyjazdu.pdf", mimeType: "application/pdf", size: 420 * KB },
    ],
  },
  {
    uid: 9003,
    from: { name: "Michał Górski", address: "michal.gorski@example.pl" },
    subject: "Załączniki: jeden duży plik",
    text: "Archiwum projektu, ponad trzydzieści megabajtów.",
    files: [{ name: "Projekt makiet.zip", mimeType: "application/zip", size: 34 * MB }],
  },
  {
    uid: 9004,
    from: { name: "Przychodnia Zdrowie", address: "rejestracja@przychodnia.example.pl" },
    subject: "Załączniki: brak sieci i brak na serwerze",
    text: "Pierwszy plik nie pobierze się za pierwszym razem, drugi zniknął z serwera.",
    files: [
      {
        name: "Wyniki badań.pdf",
        mimeType: "application/pdf",
        size: 1_900 * KB,
        behaviour: "offlineOnce",
      },
      { name: "Skierowanie.pdf", mimeType: "application/pdf", size: 96 * KB, behaviour: "gone" },
      { name: "Zalecenia lekarza.pdf", mimeType: "application/pdf", size: 120 * KB },
    ],
  },
  {
    uid: 9005,
    from: { name: "PKP Intercity", address: "bilet@pkp-intercity.example.pl" },
    subject: "Załączniki: trzy pliki",
    text: "Bilet, regulamin i faktura.",
    files: [
      { name: "Bilet.pdf", mimeType: "application/pdf", size: 71 * KB },
      { name: "Regulamin przewozu.pdf", mimeType: "application/pdf", size: 640 * KB },
      { name: "Faktura.pdf", mimeType: "application/pdf", size: 38 * KB },
    ],
  },
  {
    uid: 9006,
    from: { name: "Sklep Łąka", address: "zamowienia@sklep-laka.example" },
    subject: "Załączniki: wiadomość z grafiką",
    text: "Potwierdzenie zamówienia 2026/11/0412. Faktura i regulamin w załączeniu.",
    html: '<table width="600"><tr><td><h1>Dziękujemy za zamówienie</h1><p>Potwierdzenie zamówienia 2026/11/0412.</p></td></tr></table>',
    files: [
      { name: "Faktura 2026-11-0412.pdf", mimeType: "application/pdf", size: 64 * KB },
      { name: "Regulamin sklepu.pdf", mimeType: "application/pdf", size: 310 * KB },
    ],
  },
];

/** The place a demo message "lives" on the demo server. */
export function demoLocation(uid: number): MessageLocation {
  return { accountId: DEMO_ACCOUNT_ID, folderId: "INBOX", uidValidity: "1", uid };
}

/** The name a demo file is stored under: what sync would make of it. */
export const demoStoredName = (file: DemoFile): string => safeFileName(file.name);

/** A file's bytes are made up, but the same every time, so a saved copy can be compared. */
function fill(chunk: Uint8Array, offset: number, seed: number): void {
  for (let i = 0; i < chunk.byteLength; i++) chunk[i] = (offset + i + seed) & 0xff;
}

const CHUNK = 128 * 1024;
/** From here a file arrives slowly enough to watch the ring. */
const SLOW_FROM = 1_000_000;
const SLOW_CHUNK_MS = 25;

class DemoOffline extends Error {
  readonly kind = "unreachable";
  constructor() {
    super("The demo server is pretending to be offline");
    this.name = "DemoOffline";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The demo server's side of `MailAttachmentPort`. It serves only the messages above, only for the
 * demo account, and keeps nothing between runs.
 */
export class DemoMail {
  private readonly attempts = new Set<string>();

  /** The demo account has no password and no server: the downloads of its mail come from here. */
  serves(account: Pick<StoredAccount, "id" | "imap">): boolean {
    return account.id === DEMO_ACCOUNT_ID && account.imap.host === DEMO_HOST;
  }

  connection(): DownloadConnection {
    return {
      attachments: { download: (location, partId) => this.download(location, partId) },
      close: async () => {},
    };
  }

  private fileAt(location: MessageLocation, partId: string): DemoFile | undefined {
    const message = DEMO_MESSAGES.find((m) => m.uid === location.uid);
    // Part 1 is the text of the letter; the files follow it.
    return message?.files[Number(partId) - FIRST_FILE_PART];
  }

  private async download(location: MessageLocation, partId: string): Promise<PartDownload> {
    const file = this.fileAt(location, partId);
    if (!file || location.accountId !== DEMO_ACCOUNT_ID) return { kind: "gone" };
    const id = `${location.uid}/${partId}`;
    if (file.behaviour === "gone") return { kind: "gone" };
    if (file.behaviour === "offlineOnce" && !this.attempts.has(id)) {
      this.attempts.add(id);
      throw new DemoOffline();
    }
    const slow = file.size >= SLOW_FROM;
    const seed = location.uid + Number(partId);
    return {
      kind: "found",
      content: (async function* () {
        for (let offset = 0; offset < file.size; offset += CHUNK) {
          const chunk = new Uint8Array(Math.min(CHUNK, file.size - offset));
          fill(chunk, offset, seed);
          if (slow) await sleep(SLOW_CHUNK_MS);
          yield chunk;
        }
      })(),
    };
  }
}
