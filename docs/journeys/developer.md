# Developer

Provisions and runs the instance: Cloudflare resources, DNS, the email provider, Access. May not write a single post; owns Settings, the template, and keeping the thing healthy.

**Stresses:** Settings, the docs room, the error-recovery paths (a wedged send, a missed fire).

## Onboarding

1. Work through `docs/setup/` end to end: provision, Access, the email provider, sending-domain DNS, wire the archive to a website, verify.
2. Deploy, confirm `/api/version` reports the expected build.
3. Hand off to a publisher, possibly themself, once the verify checklist passes.

## Steady state: keep the lights on

1. Periodically check Settings for anything read-only that drifted from what's actually deployed (the email sender, the sending domain).
2. Notice a bounce or complaint rate creeping up; check Subscribers for suppressions, consider the provider's own reputation signals.
3. Get paged by, or notice in logs, a stuck or wedged send; resolve it per SPEC §12.
4. A missed fire is flagged loudly rather than silently late; investigate why the sweep didn't run on time.

## Steady state: change the app itself

1. Add or rotate a service token for Claude.
2. Update the email template or identity to match a rebrand, confirm scheduled posts remake correctly.
3. Deploy a new build, confirm none of SPEC's invariants (I1 through I6) regressed.
