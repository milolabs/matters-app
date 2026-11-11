# 0115. Every window hears a changed status

- Status: Accepted
- Date: 2026-11-10
- Amends: [0052](0052-things-that-matter.md) (how a window keeps the agent's status),
  [0112](0112-what-you-answered-waits-for-its-reading.md) (rule 5: the pushes an outbox change
  sends)

## Context

- **A window keeps a copy of the agent's status.** It says whether AI is on (the Matters tab exists),
  which accounts the person agreed to, how far the reading is (the tab's `12/214`), and whether it is
  paused and why. A push (`agentChanged`) carried no data, so the window asked for the list again
  and, while Matters was not on screen, for the status only when its copy was older than 5 s.
- **Why the 5 s.** A reading pushes up to four times a second, and a status read counts what is in
  Matters (ADR 0052, rule 6), a walk over the mailbox. On a large mailbox a read per push would be a
  steady load for a number nobody is looking at.
- **What the 5 s cost.** A change that came within 5 s of the last read was not read at all until a
  later push came more than 5 s after it. AI turned on in Settings while the mail window had read
  its status a moment before (every outbox change pushes since ADR 0112) left the window without a
  Matters tab until the next push, if any. AI turned off, consent withdrawn, a pause, a reading that
  stopped at the plan's limit: the last push of each often came inside the 5 s, and nothing came
  after it, so the window showed the old state until something else happened.
- A refresh asked while another ran was folded into it; it decided again by the age of the copy,
  so a fold could not carry a need of its own.

## Decision

1. **A request that changes the status says so.** Every request whose answer is the status after
   it (turning AI on or off, withdrawing consent, *Pause*, *Continue*, the models, the week share,
   the reading window, the talk's loop, *Look again*, *Try again*) makes the backend push
   `agentChanged` with `status: true` once the answer is there. Pushes held to four a second keep
   the mark. A refused request adds no mark.
2. **A window reads the status on that push, however fresh its copy.** The mark is kept until a
   status read starts, so a push folded into a refresh that is already running is not lost.
3. **A push the status was skipped for is read when the copy ages out.** One read is waiting at a
   time, 5 s after the last one, and any read that starts first answers it. Opening Matters reads it
   at once.
4. **The rest stays.** A reading's own pushes carry no mark. While Matters is on screen every push
   reads the status, as before; while it is not, at most one status read per 5 s.

## Consequences

- AI on or off, consent and a pause from any window reach every other window within the push
  coalescing (about 0.25 s in the backend, 0.3 s in the window) and one status read, where before a
  window could wait for the next push, possibly indefinitely.
- What only the reading changes (its progress, the plan's limit, its end) reaches a window that is
  not showing Matters within 5 s, and no longer waits for another push.
- A long reading costs a window the same: one status read per 5 s while Matters is not shown (11 a
  minute in the store's test against 10 before).
- An account removed in Settings withdraws its consent in the worker, not by a request of rule 1;
  its push carries no mark, so other windows see it within 5 s.
