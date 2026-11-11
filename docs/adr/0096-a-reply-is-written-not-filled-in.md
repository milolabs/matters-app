# 0096. A reply is written, not filled in

- Status: Accepted
- Date: 2026-11-09

## Context

Replying to an HTML newsletter opened a composer that could not send. The text version of an HTML
message writes every link as `word [https://…]`, the reply quotes that text with `> `, and the
placeholder check (`gaps`) read the whole body, the quote included. Every link became a "gap",
and the footer listed some thirty addresses in red as "Fill in … first" before a word was typed.
The quote itself was mostly those addresses and runs of empty `>` lines.

## Decision

1. Gaps are looked for only in the writer's own lines. A line that starts with `>` belongs to
   someone else, whatever brackets it holds.
2. A bracket that starts with a scheme (`https:`, `mailto:`, …) or `www.` is a link, never a gap,
   also in the writer's own words.
3. A reply quotes `replyQuoteText`: the text without the ` [https://…]` notes after links and with
   no more than one empty line in a row. The words are unchanged. A forward still quotes the text
   whole, since there the addresses may be what is passed on.
4. What blocks Send is shown as a quiet hint in the footer, and in red only once Send has been
   pressed or a send failed. Send is never disabled for a blocker: pressing it says why it can't go.
5. The composer's From/To/Cc/Bcc/Subject are lines of a mail header with a hairline between them,
   not filled boxes.

## Consequences

A reply to any HTML message can be sent as soon as it has words in it. A placeholder typed inside
a quoted line no longer blocks Send; that is the writer's own choice of where to type.
