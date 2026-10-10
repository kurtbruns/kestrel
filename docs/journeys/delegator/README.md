# Delegator

Works mostly by conversing with Claude rather than clicking through the dashboard: drafts, schedules, and checks status in plain language, and opens the dashboard mainly to glance at something or step in directly.

**Stresses:** the cross-client concurrency seam, meaning what happens when a human and Claude act on the same post: attribution in the revision trail, the soft-lock, refused-save behavior.

This archetype is the one unique to Kestrel's two-client design (SPEC §1). Nothing here would be a distinct persona in a single-client newsletter tool.

## Their world

- The curated demo list: `npm run seed`.
- Claude's half of a journey calls the API with a service token, `GET /api/dev/token?kind=service` locally, the same kind of principal Claude is in production. The human's half runs in the dashboard, which mints its own human token.

## Journeys

- [Onboarding](onboarding.md), sketch
- [Draft and schedule through Claude](draft-and-schedule.md), sketch
- [A human edits what Claude scheduled](human-edits-what-claude-scheduled.md), sketch
