# 0040. Attachments go in the message; large files can later leave through carriers

- Status: Accepted
- Date: 2026-11-04
- Refines: [0020](0020-sending-outbox-and-compose.md) (rule 1, and "attachments come in a later step")

## Context

Compose has no attachments. The first version only needs ordinary ones: files inside the MIME
message. But mail servers cap a message at about 20 to 25 MB, and base64 makes a file about 37%
larger on the wire, so a 19 MB file is already over a 25 MB limit. The usual way past the cap is to
put the file in a cloud store (Dropbox, Google Drive and others) and send a signed link.

We do not build that now. We do want it to arrive as an adapter (ADR 0004) without reopening the
draft, the approval or the composer, and we want the one place where the product decides "this is
large" to exist from the first version.

## Decision

### What ships now

1. A draft has a list of attachments: id, file name, size in bytes, and `delivery`. The only
   delivery that exists is `{ kind: "inline" }`, meaning a part of the MIME message.
2. The fingerprint covers each attachment's id, name, size and delivery, in order. Adding,
   removing, renaming or changing the delivery of a file is a change like any other and voids an
   approval. The key is left out of the canonical form when the list is empty, so existing drafts
   keep their fingerprints. An attachment's id names one immutable stored copy (ADR 0041, rule 2),
   so the id stands for the bytes.

### The seam: `notifyIfLarge`

3. Core has one pure function, called whenever the list of files or the account's limit changes,
   and again when Send is pressed:

   ```ts
   notifyIfLarge(files, limit, carriers): LargeNotice | null

   interface LargeNotice {
     kind: "heavy" | "tooLarge";
     encodedBytes: number;       // what the server will count, not the sum of the file sizes
     limitBytes: number | null;  // the account's, when known
     offers: readonly CarrierOffer[]; // ways to send the files some other way; empty today
   }
   ```

   - `tooLarge`: the encoded message is over the account's known limit. It is a `SendBlocker`.
   - `heavy`: the encoded message is 10 MB or more and within the limit (or the limit is unknown).
     It is said, and it blocks nothing: a recipient's server may refuse what ours accepts.
   - `null` otherwise.

   Nothing else in the code compares a size to a limit. The composer shows what the notice says,
   and the day carriers exist the same notice carries their offers.
4. The limit is what the server announces in `SIZE` on EHLO, kept per account and refreshed by each
   connection. When a server announces none the limit is unknown and only `heavy` can appear.

### The port, with no adapter yet

5. Core defines `AttachmentCarrierPort` and the deps of the send use cases take
   `carriers: readonly AttachmentCarrierPort[]`. The app passes an empty list. A fake carrier in
   the testkit exercises the seam, so it cannot rot unnoticed.

   ```ts
   interface AttachmentCarrierPort {
     readonly id: string;    // "dropbox"
     readonly label: string; // "Dropbox"
     /** Cheap and offline: can this carrier take this file for this account? */
     offerFor(file: StoredAttachment, accountId: string): CarrierOffer | null;
     /** Runs at hand-off only. Throws for a definite failure; never leaves a half result. */
     carry(file: StoredAttachment, context: CarryContext): Promise<CarriedFile>;
   }

   type Delivery =
     | { kind: "inline" }
     | { kind: "link"; carrierId: string };
   ```

### The rules a carrier must follow when one is built

6. **The user chooses, per file.** A file never moves to a link by itself, and a failed carrier
   never falls back to inline or the other way round. Sending a file to a third party is the
   user's decision, made where they can see it.
7. **Nothing leaves before the undo window ends.** `carry` runs at hand-off, after the approval is
   checked again. Undo never has to chase a file already in someone's cloud.
8. **A carried file is kept with the operation**, as the MIME is (ADR 0020, rule 6). A retry reuses
   the link and does not upload again. The message is built once, after every carry has finished.
9. **A carry failure is a definite failure**: nothing was submitted, Retry is safe, and the reason
   names the file and the carrier.
10. **The body the user wrote is not edited.** Links are added when the message is built, in both
    the text and the HTML part, through the compose pipeline's safe link schemes (ADR 0020, rule
    11).
11. **The composer says who can open the link and until when** before Send, because the carrier's
    sharing settings decide what the recipient and anyone they forward it to can reach. The
    default asked of a carrier is the narrowest it offers.
12. Carrier tokens live in the vault behind `CredentialPort` (ADR 0018), and never reach SQLite,
    logs or the renderer. Carriers run in the sync worker. Their SDKs and licenses pass ADR 0013.
13. "Plugin" here means an adapter compiled into the app. Loading third-party code at run time is
    a separate decision with its own ADR.

## Consequences

- Adding Dropbox later means one package, one list entry and one sign-in in settings. The draft,
  the approval, the composer's notice and the tray stay as they are.
- `delivery` and the empty `carriers` list exist before they are needed. That is deliberate and it
  is all: no carrier UI, no OAuth and no upload code ship now.
- Until a carrier exists, `tooLarge` has one way out: remove files. The notice says so plainly.
- The limit is the sending server's. A recipient's smaller limit still shows up as a bounce, which
  is what `heavy` warns about.
