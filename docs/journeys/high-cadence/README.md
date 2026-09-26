# High-cadence publisher

Sends weekly or more, to a larger list, and reuses a tuned template across posts. Watches deliverability closely: bounce and complaint rates, unsubscribes after a send, suppressions. Most publishers at this cadence already have an audience somewhere else, so their first contact with Kestrel is a migration.

**Stresses:** the Sent record's delivery-outcome detail, Settings/Template's "in use by N scheduled posts" and remake behavior, subscriber list hygiene.

## Their world

- **Onboarding** starts from a fresh install (`npm run reset`), with [`fixtures/existing-audience.csv`](fixtures/existing-audience.csv) standing in for the list they bring from their previous tool.
- **Steady state** needs a list of the right order of magnitude: `npm run seed -- --size 10k`.

## Journeys

- [Onboarding: arriving with an audience](onboarding.md), written in full
- [Send a post on schedule](send-on-schedule.md), sketch
- [Change the template mid-flight](change-the-template-mid-flight.md), sketch
