# Developer: keep the lights on

**Archetype:** [Developer](README.md) · Sketch

## Steps

1. Check Settings for anything read-only that has drifted from what's actually deployed (the email sender, the sending domain).
2. Notice a bounce or complaint rate creeping up; check Subscribers for suppressions and consider the provider's own reputation signals.
3. Get paged by, or notice in the logs, a stuck or wedged send, and resolve it per SPEC §12.
4. A missed fire is flagged loudly rather than silently late; find out why the sweep didn't run on time.
