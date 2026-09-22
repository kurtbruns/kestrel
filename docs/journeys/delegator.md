# Delegator

Works mostly by conversing with Claude rather than clicking through the dashboard: drafts, schedules, and checks status through natural language, and opens the dashboard mainly to glance at something or step in directly.

**Stresses:** the cross-client concurrency seam, what happens when a human and Claude act on the same post: attribution in the revision trail, the soft-lock, refused-save behavior.

This archetype is the one unique to Kestrel's two-client design (SPEC §1). Nothing here would be a distinct persona in a single-client newsletter tool.

## Onboarding

1. Follow the setup guide's "Connect Claude" step (`docs/setup/07-connect-claude.md`) to issue a service token.
2. Ask Claude to confirm it's connected ("what can you do here?"); Claude reads `/api/docs` and `/api/reference` to answer.
3. Ask Claude to draft a first post; open the dashboard just to see it landed.

## Steady state: draft and schedule through Claude

1. "Draft a post about X." Claude creates it via the API.
2. The publisher opens the dashboard to read the draft, doesn't edit.
3. "Schedule it for Friday morning." Claude schedules it.
4. "Did it send? Any bounces?" Claude reads back the Sent record.

## Steady state: a human touches what Claude scheduled

1. Claude has scheduled a post: frozen render, soft-locked, review window open.
2. The publisher opens the dashboard directly and fixes a typo mid-window.
3. Confirm the save succeeds, the schedule isn't disturbed, and the revision trail attributes the edit to the human, not Claude.
4. Ask Claude about the post's status afterward; confirm Claude's view agrees with what the human just did.
