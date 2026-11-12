import { describe, expect, it } from "vitest";
import {
  AUTOMATED_HEADER_NAMES,
  isAutomatedByBody,
  isAutomatedByHeaders,
  isAutomatedSender,
  looksLikeServiceNotice,
} from "../src/index.ts";
import { QUICK_MS, timed } from "./support.ts";

describe("isAutomatedSender", () => {
  it.each([
    "noreply@shop.example",
    "no-reply@shop.example",
    "No_Reply@shop.example",
    "no.reply@shop.example",
    "donotreply@bank.example",
    "do-not-reply@bank.example",
    "noreply+abc123@shop.example",
    "no-reply-billing@shop.example",
    "mailer-daemon@mail.example",
    "postmaster@mail.example",
    "bounces+77@mail.example",
    "notifications@github.example",
    // The marker at the end of a longer name (ADR 0066, rule 6).
    "messaging-digest-noreply@shop.example",
    "x-no-reply@shop.example",
    "billing.donotreply@bank.example",
    "Alerts_NoReply@bank.example",
    "orders+no_reply@shop.example",
  ])("%s is automated", (address) => {
    expect(isAutomatedSender(address)).toBe(true);
  });

  it.each([
    "anna@northwind.example",
    "reply@northwind.example",
    "noreplyanna@northwind.example",
    "notify.me@northwind.example",
    "anna-noreplyish@northwind.example",
    "noreplyto-anna@northwind.example",
    "reply-anna@northwind.example",
    "a@b.example",
    "",
  ])("%s is not", (address) => {
    expect(isAutomatedSender(address)).toBe(false);
  });
});

describe("isAutomatedByHeaders (ADR 0052, rule 4; ADR 0066, rule 6)", () => {
  const h = (key: string, value: string) => ({ key, value });

  it("is true for a list, a program, or bulk mail", () => {
    expect(isAutomatedByHeaders([h("List-Unsubscribe", "<mailto:x@y.example>")])).toBe(true);
    expect(isAutomatedByHeaders([h("list-id", "<news.example>")])).toBe(true);
    expect(isAutomatedByHeaders([h("Auto-Submitted", "auto-generated")])).toBe(true);
    expect(isAutomatedByHeaders([h("Precedence", " Bulk ")])).toBe(true);
  });

  it("is false for a person, `Auto-Submitted: no` and ordinary precedence", () => {
    expect(isAutomatedByHeaders([])).toBe(false);
    expect(isAutomatedByHeaders([h("Auto-Submitted", "no")])).toBe(false);
    expect(isAutomatedByHeaders([h("Precedence", "normal"), h("Subject", "x")])).toBe(false);
  });

  it("asks the server for exactly the four headers it reads", () => {
    expect([...AUTOMATED_HEADER_NAMES].map((n) => n.toLowerCase()).sort()).toEqual([
      "auto-submitted",
      "list-id",
      "list-unsubscribe",
      "precedence",
    ]);
  });
});

describe("isAutomatedByBody (ADR 0111)", () => {
  const offer = "Deals of the week\n\nShoes -40%\nJackets -30%\n\nShop now";

  it.each([
    `${offer}\n\nThis email was sent to reader@mail.example\nIf you no longer want these, unsubscribe`,
    `${offer}\n\nManage your email preferences | Privacy`,
    `${offer}\n\nUpdate your preferences or opt out at any time`,
    `${offer}\n\nYou are receiving this email because you signed up at shop.example`,
    "Nowości tygodnia\n\nJeżeli chcesz się wypisać z listy, kliknij tutaj",
    "Promocja\n\nNie chcesz już otrzymywać tych wiadomości? Kliknij",
    "Promocja\n\nZrezygnuj z subskrypcji",
    "Promocja\n\nTa wiadomość została wysłana na adres czytelnik@poczta.example",
    "Otrzymałeś ten list, ponieważ zapisałeś się do listy osób, które chcą wiedzieć więcej.",
  ])("reads a mailing's footer: %j", (text) => {
    expect(isAutomatedByBody(text, "Deals of the week")).toBe(true);
  });

  it("does not read a footer in a reply or a forward of a mailing", () => {
    const quoted = `Have a look at this one\n\n${offer}\n\nUnsubscribe here`;
    expect(isAutomatedByBody(quoted, "Re: Deals of the week")).toBe(false);
    expect(isAutomatedByBody(quoted, "Fwd: Deals of the week")).toBe(false);
    expect(isAutomatedByBody(quoted, "PD: Deals of the week")).toBe(false);
    expect(isAutomatedByBody(quoted, "ODP: Deals of the week")).toBe(false);
  });

  it("stops at a quote, so a footer quoted under a person's words does not count", () => {
    const below = (line: string) =>
      `Sure, see you on Monday.\n\nAnna\n\n${line}\n${offer}\nUnsubscribe`;
    expect(isAutomatedByBody(below("> Deals of the week"), "Monday")).toBe(false);
    expect(
      isAutomatedByBody(below("On Mon, 3 Mar 2025, Shop <news@shop.example> wrote:"), "Monday"),
    ).toBe(false);
    expect(
      isAutomatedByBody(below("W dniu 3.03.2025 o 10:00 Sklep <news@shop.example> pisze:"), "x"),
    ).toBe(false);
    expect(isAutomatedByBody(below("---------- Forwarded message ---------"), "x")).toBe(false);
    expect(isAutomatedByBody(below("From: Shop <news@shop.example>"), "x")).toBe(false);
  });

  it("looks only at the end of the sender's words", () => {
    const early = `Please unsubscribe me from the old list.\n\n${"We talked about the plan. ".repeat(100)}\nAnna`;
    expect(isAutomatedByBody(early, "Plan")).toBe(false);
  });

  it.each([
    // A person's calendar invitation says how to stop updates for the event, not for a list.
    "Interview\n\nYou are receiving this email because you are an attendee on the event. To stop receiving future updates for this event, decline this event.",
    "Spotkanie\n\nOtrzymujesz tę wiadomość, ponieważ jesteś gościem wydarzenia. Aby zrezygnować z otrzymywania aktualizacji tego wydarzenia, odrzuć je.",
    // Bills and alerts that say they were generated: a program, but not a list.
    "Invoice 12/2026 is ready.\n\nThis message was generated automatically, please do not reply.",
    "Faktura 12/2026\n\nWiadomość wygenerowana automatycznie, prosimy na nią nie odpowiadać.",
    // A signature disclaimer.
    "Best regards,\nAnna\n\nIf you received this e-mail in error, please delete it.",
    // A person who writes out an invoice.
    "Proszę wypisz fakturę na firmę.\n\nAnna",
    "",
  ])("leaves a person's mail and a program's notice alone: %j", (text) => {
    expect(isAutomatedByBody(text, "Subject")).toBe(false);
  });
});

describe("looksLikeServiceNotice (ADR 0066, rule 6)", () => {
  it.each(["Anna just messaged you", "Anna wysłała Ci wiadomość", "Nowa wiadomość od Anny"])(
    "keeps word that a person wrote through a platform: %s",
    (subject) => {
      expect(looksLikeServiceNotice(subject)).toBe(true);
    },
  );

  it.each([
    "Faktura FV/12/2026 do opłacenia",
    "Twój rachunek za listopad",
    "Potwierdzenie płatności",
    "PLATNOSC nieudana",
    "Brak zapłaty - ostatnie wezwanie",
    "Termin ważności upływa",
    "Twoja domena wygasa za 3 dni",
    "Odnowienie hostingu",
    "Windykacja: zaległa należność",
    "Monit w sprawie umowy",
    "Zaległość w opłacie",
    "Nieudana próba logowania",
    "Konto zablokowane",
    "Zmień hasło",
    "Ważne: bezpieczeństwo konta",
    "Zmiany w umowie",
    "Zwrot środków",
    "Przekroczono limit",
    "Your invoice is ready",
    "Payment received",
    "Account OVERDUE",
    "Your domain will expire",
    "Please renew",
    "Delivery failed",
    "Your account was suspended",
    "Card blocked",
    "Security alert",
    "Reset your password",
    "Refund issued",
    "Deadline tomorrow",
    "Your files will be deleted",
    "Verify your email",
  ])("%s is a service notice", (subject) => {
    expect(looksLikeServiceNotice(subject)).toBe(true);
  });

  it.each([
    "Weekly digest: ten things we liked",
    "Nowości w naszym sklepie",
    "Join us for the summer sale",
    "",
  ])("%s is not", (subject) => {
    expect(looksLikeServiceNotice(subject)).toBe(false);
  });
});

describe("isAutomatedByBody and a long subject", () => {
  it("takes linear time on a prefix and a long run of white space with no colon", () => {
    const subject = `re${"\t".repeat(50_000)}x`;
    const { result, ms } = timed(() =>
      isAutomatedByBody("Hello\n\nUnsubscribe from this list", subject),
    );
    expect(typeof result).toBe("boolean");
    expect(ms).toBeLessThan(QUICK_MS);
  });

  it("still knows a reply by a numbered prefix with white space around it", () => {
    expect(isAutomatedByBody("Hello\n\nUnsubscribe from this list", "RE [2] : News")).toBe(false);
  });
});
