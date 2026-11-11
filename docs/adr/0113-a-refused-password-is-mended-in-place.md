# 0113. A refused password is mended in place

- Status: Accepted
- Date: 2026-11-10
- Amends: [0023](0023-lookup-by-mx-and-probing.md) (context: accounts cannot be edited; the
  password now can)
- Relates to: [0114](0114-a-refused-sign-in-says-why.md) (why a server refused: which refusals
  stop the work and which open the form)

## Context

- **App passwords end.** A person revokes one, a host rotates it, a security check expires it.
  The sync then shows *Password rejected* (ADR 0018) and the only way out was *Remove account*,
  which deletes the account's messages, index, drafts and files from this computer (ADR 0023 left
  accounts not editable). Everyone who signs in with an app password meets this sooner or later.
- **One password per account.** The vault keeps one credential per account (ADR 0018): the
  incoming server's user name and the password. The outgoing server has a user name of its own in
  the account's settings and uses the same password (ADR 0020); setup cannot store a second one.
- **What a refused password did before.** The scheduler already stopped on a refusal: no
  back-off retry for the sync or the inbox watch, only *Sync now* tried again, once. Everything
  else logged in on its own with the refused password: read state and moves waiting for the server
  retried with back-off up to 5 minutes, for as long as the app ran (up to about 24 failed logins
  an hour each); a send, its Sent copy, a download and the size probe tried once each time they
  ran. Providers lock a mailbox after a run of failed logins, and the person cannot see why.

## Decision

1. **The password can be replaced, and only it.** Settings › Accounts has *Change password* (key
   `p`) on every account's row. The address, the user names and the servers stay as they are; a
   wrong server is still fixed by removing and adding the account. Editing those should follow,
   with the same login tests, as its own decision: a changed server or user name can point the
   local mail at another mailbox, which a password cannot.
2. **A refused password shows its form; another refusal says what it needs.** While the server
   refuses the saved password for a reason a new password can end (ADR 0114's `credentials`,
   `appPassword`, `expired`, and `unknown`, which is most often a wrong password), the account's
   row opens the form by itself, says the reason's sentence and that the mail on this computer
   stays, with the server's own words under it, and its button reads *Enter new password*. A
   refusal no password ends (`webLogin`, `imapOff`, `notAllowed`, `browserOnly`,
   `encryptionRequired`) opens no form: the row says the reason's sentence with its next step
   (sign in on the website, turn IMAP on in webmail, ask an admin, then *Sync now*; or that a
   password cannot work there) and the server's words. The status line says the reason in a few
   words ("IMAP is turned off", "App password needed"), and opens Settings on Accounts when it
   shows an account error. Escape closes the form; the person can open it again.
3. **Verify, then replace.** The backend (the sync worker, which writes) logs in to the incoming
   server with the new password, then to the outgoing server when the account sends, with that
   server's user name. Only when both took it is the vault written, in one atomic replace of the
   account's entry (ADR 0018). On any refusal, or when the vault cannot be written, the saved
   password is as it was and the form says why (the setup's own explanations) and that it is
   unchanged, with the server's own words under it (ADR 0114). An outgoing server that could not be asked (unreachable, a certificate, a bad answer)
   says nothing about the password: it is saved, and the row says the first send will tell.
4. **A refused password is not used again on its own.** In the sync worker, the scheduler's
   refusal marks the account (`RejectedPasswords`); work that logs in on its own gets an `auth`
   error from the vault instead of the password, without a connection: read state and moves wait
   in their queues, a send fails with that reason, a download says so. The scheduler reads the
   vault itself and keeps ADR 0018's rule: no retry, one more login on *Sync now*. The mark
   goes with a sync that settles without error, a verified new password or the account's removal.
   It lives in memory: after a restart the first sync finds out again, with one login for the sync
   and one for the watch. This holds for every refusal of rule 2, whether or not it opens the form.
4a. **A temporary refusal is tried again, slowly.** `unavailable` and `throttled` (ADR 0114) are
   the server's side, for now: they mark nothing and open no form. The sync tries again after
   1, 2, 4, 8, 16 and then every 30 minutes (each scaled at random into 50–100 %, so at most about
   seven logins in the first hour and two to four an hour after), instead of the 1 s to 5 minutes
   other failures get, so the tries do not feed the count that locks a mailbox. The watch does not
   retry on its own then: the next sync that gets in (a retry, the 15-minute sync or *Sync now*)
   opens it, so the account makes one login per try, not two. The row says the server's reason
   and that Matters tries again by itself.
5. **A new password reconnects at once.** After the vault write the scheduler drops what the old
   password left (its failures, a watch opened with it), starts a full sync and a new watch, and
   the row shows *Connecting…*. Queued read state and moves go at their next turn.
6. **The password travels once.** It goes from the form to the backend in one request
   (`changePassword`), as in setup, and into the vault through the main process (ADR 0018). No
   answer, status, log line or error carries it: adapter errors are scrubbed, and the use case
   scrubs again. The form holds it in one signal and empties it as soon as the backend answers.

## Consequences

- A revoked or rotated app password costs a minute and no local data.
- A provider sees one failed login per launch (two connections) and per *Sync now* while the
  password is refused, instead of a steady stream from queued work.
- Mail sent while the password is refused fails at once with that reason; it can be sent again
  after the new password is saved.
- A server that refuses one login by mistake with an answer that names no temporary reason (a bare
  `NO` for a passing fault) keeps the account waiting until *Sync now* or a new password, as the
  sync already did. One that says `UNAVAILABLE`, `LIMIT`, 454 or "try again later" is retried.
- While a server answers `throttled` or `unavailable`, work that logs in on its own (read state,
  moves, sends) is not held back: it keeps its own back-off (up to 5 minutes) and may meet the
  same refusal.
- The account's two servers cannot have different passwords. A host that wants that is not served
  yet; the outgoing refusal says receiving works with the password and sending would not.
