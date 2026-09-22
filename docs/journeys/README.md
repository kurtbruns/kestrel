# Publisher journeys

**What this is.** A working map of how each of Kestrel's roles (`docs/SPEC.md` §1: publisher, developer, reader) actually uses the app, end to end, in concrete steps. It exists to get the big picture right before hardening any of it into tests: this directory sits below SPEC and DESIGN, as working material toward a cross-client journey test suite, not a governing document itself.

**Status.** Skeleton. Each archetype file sketches its journeys at the granularity meant to become deterministic tests later; most are still stubs, and none of this is a commitment about what ships.

## The publisher archetypes

Different publishers stress different parts of the app. Four archetypes, not because Kestrel forces a taxonomy on its users, but because each maps to a distinct slice of the system:

| Archetype | Cadence / scale | Stresses |
|---|---|---|
| [Solo publisher](solo-publisher.md) | Infrequent, small list | The editor/preview loop, the schedule/cancel review window, the dashboard's at-a-glance state |
| [High-cadence publisher](high-cadence-publisher.md) | Frequent, larger list | Delivery-outcome detail, template reuse and the remake flow, subscriber list hygiene |
| [Delegator](delegator.md) | Works mostly through Claude | The cross-client concurrency seam: attribution, the soft-lock, refused-save behavior |
| [Developer](developer.md) | Runs the instance, may not write posts | Settings, the docs room, the error-recovery paths (a wedged send, a missed fire) |

These four are all variations on SPEC's **publisher** role. One person is often both publisher and developer (SPEC §1); "developer" here names the role, not always a distinct person. **Reader** journeys (subscribe, confirm, receive, unsubscribe) are a separate, simpler category that doesn't need archetypes the same way, and may get their own file later.

## Onboarding as a phase, not an archetype

Every archetype passes through a first-run phase once: an empty subscriber list, an unedited template, no sent history. That looks different enough from steady-state use that each archetype file sketches it separately, before its steady-state journeys.

The high-cadence publisher's onboarding is the most telling. That archetype is the one most likely arriving with an existing audience, migrated from another newsletter tool, and its onboarding journey has an import-my-list step that Kestrel doesn't support today. That gap is left in the sketch on purpose rather than glossed over: a journey that can't complete is exactly the kind of thing this exercise should surface as work still needed.

## Granularity

A journey is a numbered list of concrete steps, at the level of detail a step would need to become a test assertion later: not "write a good post," but "write subject + Markdown body, watch autosave settle." See [solo-publisher.md](solo-publisher.md) for the pattern.
