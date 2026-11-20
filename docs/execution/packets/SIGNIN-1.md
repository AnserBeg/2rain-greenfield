# SIGNIN-1 — staff sign-in and authority for human decisions

Slice 0 proposes [ADR-0081](../../decisions/ADR-0081-staff-sign-in-and-decision-authority.md).
This checkpoint changes documentation only. Implementation awaits the orchestrator's Fable read.

## Design decisions

1. Staff use user-verified passkeys. A revocable server-side session supplies the staff principal.
   A spare key or attended recovery allows a person to regain access before email exists.
2. A fresh assertion binds the person's decision to the exact action and outcome. A separate
   verifier owns activation evidence. Slice 2 must prove both ADR-0073 findings closed.
3. A signed customer link admits one verified contact to one purpose. The contact authenticates
   independently. Documents owns the upload scope and the challenge for the exact PDF.
4. Staff administration uses scoped policy grants. PostgreSQL holds the acknowledged drafts,
   task steps and request keys needed to recover on a different web instance.

## Slices and gates

0. Design proposal. Run the record check, integrate the proposal and stop for the Fable ruling.
1. Staff sign-in, session rotation and trusted request entry.
2. Human decisions and independently verified activation receipts.
3. Scoped customer links and verified contact access.
4. Staff invitations, roles, companies, delegation, recovery and deactivation.
5. Restart and two-instance recovery of drafts and tasks.

## Test it yourself

Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
Open the ADR and trace three cases. These are design checks for this checkpoint.

- In **Human decisions and activation evidence**, change one recipient after confirming a send.
  Find where the person must review the new recipient and why a prior confirmation cannot authorize it.
- In **Customer and contact links**, open a forwarded upload invitation as a different verified contact.
  Find which check refuses redemption before the invitation is consumed.
- In **Pilot persistence**, stop instance A after a task's business operation commits. Find the
  saved request key that lets instance B recover the receipt and continue at the next step.
