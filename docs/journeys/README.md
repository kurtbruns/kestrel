# Publisher journeys

**What this is.** A working map of how each of Kestrel's roles (`docs/SPEC.md` §1: publisher, developer, reader) actually uses the app, end to end, in concrete steps. It exists to get the big picture right before hardening any of it into tests. It sits below SPEC and DESIGN as working material, not a governing document.

**Status.** Early. One journey is written in full ([high-cadence onboarding](high-cadence/onboarding.md)); the rest are sketches with steps only. None of this is a commitment about what ships.

## Layout

One folder per archetype. The folder's README describes the publisher and how to set up their world; every other file in it is one journey, the unit an agent runs.

```
journeys/
  README.md        the archetypes, the shape of a journey, how to run one
  solo/            infrequent, small list, writes by hand
  high-cadence/    frequent, larger list, arrives with an existing audience
  delegator/       works mostly through Claude
  developer/       runs the instance
```

## The archetypes

Different publishers stress different parts of the app. Four archetypes, not because Kestrel forces a taxonomy on its users, but because each maps to a distinct slice of the system:

| Archetype | Cadence / scale | Stresses |
|---|---|---|
| [Solo publisher](solo/README.md) | Infrequent, small list | The editor/preview loop, the schedule/cancel review window, the dashboard's at-a-glance state |
| [High-cadence publisher](high-cadence/README.md) | Frequent, larger list | Delivery-outcome detail, template reuse and the remake flow, subscriber list hygiene |
| [Delegator](delegator/README.md) | Works mostly through Claude | The cross-client concurrency seam: attribution, the soft-lock, refused-save behavior |
| [Developer](developer/README.md) | Runs the instance, may not write posts | Settings, the docs room, the error-recovery paths (a wedged send, a missed fire) |

These four are all variations on SPEC's **publisher** role. One person is often both publisher and developer (SPEC §1); "developer" here names the role, not always a distinct person. **Reader** journeys (subscribe, confirm, receive, unsubscribe) are a separate, simpler category that doesn't need archetypes the same way, and may get their own folder later.

## Onboarding as a phase, not an archetype

Every archetype passes through a first-run phase once: an empty subscriber list, an unedited template, no sent history. That looks different enough from steady-state use that each archetype has its own onboarding journey.

The high-cadence publisher's onboarding is the most telling. That archetype is the one most likely arriving with an existing audience from another newsletter tool, and its onboarding needs an import step Kestrel doesn't have today. The gap is left in the journey on purpose: a journey that can't complete is exactly what this exercise should surface.

## Anatomy of a journey

A journey written in full has these sections:

- **Goal.** One sentence: who, what, and what they would count as done.
- **Environment.** Local, staging, or both. A step that needs a real inbox or real DNS is marked staging; a local run skips it and says so.
- **Starting world.** The exact commands that produce the state the journey begins in.
- **Steps.** What the publisher does, as intent ("bring the existing audience over"), not clicks. The agent finds its own way through the UI; finding it hard is a finding.
- **Expectations.** What good looks like, for correctness and for experience. A run is judged against these.
- **Known gaps.** What is expected to fail today. A run still attempts each one and reports whether it is still a gap, so the list notices when one closes.

A sketch has only Steps, at the level of detail a step needs to become a check later: not "write a good post," but "write subject and Markdown body, watch autosave settle."

## Running a journey

Any agent with a browser and a shell, working from this repo:

1. Build the starting world.
2. Walk the steps as the publisher would, through the dashboard. Where the journey involves Claude, call the API with a service token (`GET /api/dev/token?kind=service` locally), the principal Claude uses in production.
3. At every step, check the browser console, failed network requests, and the `wrangler dev` log. Capture a screenshot at each change of state.
4. Report against the expectations in four groups: **bugs** (the app does the wrong thing), **friction** (it does the right thing in a confusing way), **gaps** (the journey can't be completed), and **held** (expectations met, with the evidence).

Don't route around a failure to finish the journey quietly. A workaround the publisher wouldn't know to take is itself a finding.
