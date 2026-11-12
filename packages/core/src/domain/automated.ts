import { foldText } from "./text.ts";

/**
 * A message from a program, not a person, is never sent to a model (ADR 0052, rule 4). Headers
 * decide that when the parser can see them; this is the part that needs only the address.
 */
const LOCAL_PART =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?)(?:[-_.+].*)?$/;
/** The same marker at the end of a longer name: `messaging-digest-noreply@`, `x-no-reply@` (ADR 0066, rule 6). */
const NO_REPLY_SUFFIX = /[-_.+](?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply)$/;

/** Whether the address looks like a no-reply or system sender. Case-insensitive. */
export function isAutomatedSender(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = (at < 0 ? address : address.slice(0, at)).trim().toLowerCase();
  return LOCAL_PART.test(local) || NO_REPLY_SUFFIX.test(local);
}

/**
 * ADR 0052, rule 4: a message from a list or a program, by its headers alone. `Auto-Submitted`
 * counts unless it says `no` (RFC 3834 section 5); `Precedence` is the old marker of bulk mail.
 * Whether a header is present is all that `List-Unsubscribe` and `List-Id` need. The one rule: the
 * parser decides new mail with it and the sync decides stored mail with it (ADR 0066, rule 6).
 */
export function isAutomatedByHeaders(headers: readonly { key: string; value: string }[]): boolean {
  for (const h of headers) {
    switch (h.key.toLowerCase()) {
      case "list-unsubscribe":
      case "list-id":
        return true;
      case "auto-submitted":
        if (h.value.trim().toLowerCase() !== "no") return true;
        break;
      case "precedence":
        if (["bulk", "list", "junk"].includes(h.value.trim().toLowerCase())) return true;
        break;
    }
  }
  return false;
}

/**
 * What a mailing writes at the foot of every copy (ADR 0111): a way out of the list, or the
 * address the copy went to. Folded text (`foldText`), in English and Polish. Only phrases about a
 * list: "do not reply, this was generated automatically" is left out on purpose, since bills,
 * claims and sign-in alerts say it too, and a "stop receiving updates for this event" is what a
 * calendar invitation from a person says.
 */
const LIST_FOOTER = new RegExp(
  [
    String.raw`\bunsubscrib`,
    String.raw`\b(?:email|e-mail|mailing|newsletter|subscription|communication|marketing) preferences\b`,
    String.raw`\bmanage (?:your )?(?:email|e-mail|subscription|mailing|newsletter)`,
    String.raw`\bupdate your (?:email |e-mail |subscription )?preferences\b`,
    String.raw`\bthis (?:e-?mail|message|newsletter) (?:was|has been) sent to\b`,
    String.raw`\byou(?:'re| are)? receiv(?:ed|ing) this (?:e-?mail|message|newsletter) because you (?:signed up|subscribed|opted in|registered)`,
    String.raw`\b(?:wypisz|wypisac) sie\b`,
    String.raw`\bsie wypisac\b`,
    String.raw`\bwypisani[ea] sie\b`,
    String.raw`\b(?:zrezygnuj|zrezygnowac|rezygnacj[a-z]*) z (?:subskrypcji|newslettera|otrzymywania newslettera)`,
    String.raw`\bnie chcesz (?:juz )?otrzymywac\b`,
    String.raw`\bwiadomosc (?:zostala )?wyslana na adres\b`,
    String.raw`\bzapisal(?:es|as)? sie (?:do|na) (?:listy|newsletter)`,
  ].join("|"),
);

/**
 * Where a message stops being its sender's own words: a quote mark, or the header line a mail
 * program writes above a quoted or forwarded message. Matched on folded, trimmed lines.
 */
const QUOTE_START =
  /^(?:>|-{2,}\s*(?:original message|forwarded message|wiadomosc oryginalna|oryginalna wiadomosc|przekazana wiadomosc)|(?:from|od|sent|wyslano|wyslane):\s|on .{4,200} wrote:$|w dniu .{4,200} (?:napisal|napisala|pisze)\S*:?$|.{0,200}(?:napisal|napisala)\S*\s*(?:\(a\))?:$)/;

/** A subject that answers or passes on another message: `Re:`, `Fwd:`, `Odp:`, `PD:`... */
const ANSWER_SUBJECT = /^\s*(?:re|fw|fwd|aw|wg|odp|pd|tr|sv|vs)\s*(?:\[\d+\]\s*)?:/i;

/** How far from the end of the sender's own words a footer is looked for. */
const FOOTER_REACH = 2000;

/**
 * ADR 0111: a message from a list, by its text, for bulk mail whose headers do not say so (no
 * `List-Unsubscribe`, `List-Id` or `Precedence`). True when the end of the sender's own words has
 * a mailing's footer. A reply or a forward never counts, nor anything below a quote: a person who
 * answers or passes on a newsletter quotes its footer. Pure; the parser decides new mail with it
 * and the store decides stored mail with it, from the same text.
 */
export function isAutomatedByBody(text: string, subject: string): boolean {
  if (text === "" || ANSWER_SUBJECT.test(subject)) return false;
  const own: string[] = [];
  for (const line of foldText(text).split("\n")) {
    if (QUOTE_START.test(line.trim())) break;
    own.push(line);
  }
  return LIST_FOOTER.test(own.join("\n").slice(-FOOTER_REACH));
}

/** The headers `isAutomatedByHeaders` looks at: all a backfill has to ask the server for. */
export const AUTOMATED_HEADER_NAMES: readonly string[] = [
  "List-Unsubscribe",
  "List-Id",
  "Auto-Submitted",
  "Precedence",
];

/**
 * Words that make a subject a service notice (ADR 0066, rule 6): an invoice, a payment, a deadline,
 * an account problem. Stems, matched on folded text, in Polish and English. A program that writes
 * such a subject is still worth reading; a program that writes none is not.
 */
const SERVICE_STEMS = [
  // A person wrote, through a platform that sends it from a program (ADR 0067).
  "messaged you",
  "sent you a message",
  "new message",
  "wyslal ci wiadomosc",
  "wyslala ci wiadomosc",
  "nowa wiadomosc",
  "faktur",
  "rachun",
  "platnos",
  "zaplat",
  "termin",
  "wygas",
  "odnow",
  "windyk",
  "monit",
  "zalegl",
  "zaleg",
  "nieudan",
  "zablok",
  "hasl",
  "bezpiecz",
  "umow",
  "zwrot",
  "limit",
  "invoice",
  "payment",
  "overdue",
  "expir",
  "renew",
  "failed",
  "suspend",
  "blocked",
  "security",
  "password",
  "refund",
  "deadline",
  "deleted",
  "verify",
];

/** Whether a subject reads like a notice about money, a deadline, or the person's account. */
export function looksLikeServiceNotice(subject: string): boolean {
  const folded = foldText(subject);
  return SERVICE_STEMS.some((stem) => folded.includes(stem));
}

const PROGRAM_LOCAL_PART =
  /^(?:alerts?|notify|notifier|updates?|news|newsletters?|system|robot|automated?|auto|monitoring|status|digest)(?:[-_.+].*)?$/;

/**
 * Whether the address looks like a program without saying so (`alerts@`, `updates@`...). It is NOT
 * part of the hard filter of ADR 0052, rule 4, and does nothing without a rule (ADR 0054). Whatever
 * `isAutomatedSender` or the `automated` flag catches is already dropped before reading, so a rule
 * on those would do nothing; addresses like `alerts@` are where real notifications get through.
 */
export function looksLikeProgram(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = (at < 0 ? address : address.slice(0, at)).trim().toLowerCase();
  return PROGRAM_LOCAL_PART.test(local);
}
