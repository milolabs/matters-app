# 0017. Allow MIT-0

- Status: Accepted
- Date: 2026-11-03
- Amends: [0013](0013-dependency-license-policy.md)

## Context

`postal-mime` (MIME parsing) and `nodemailer` (SMTP), both planned in
[ADR 0008](0008-imap-smtp-first.md), are published as MIT-0: the MIT license
without the requirement to keep the copyright notice. MIT-0 is OSI-approved,
more permissive than MIT and compatible with AGPL-3.0. ADR 0013 did not list it.

## Decision

MIT-0 joins the list of licenses allowed without discussion. We still keep the
authors' copyright notices in third-party notices, as a courtesy.

## Consequences

`check:licenses` accepts MIT-0 packages.
