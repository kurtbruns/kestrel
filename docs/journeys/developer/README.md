# Developer

Provisions and runs the instance: Cloudflare resources, DNS, the email provider, Access. May not write a single post; owns Settings, the template, and keeping the thing healthy.

**Stresses:** Settings, the docs room, the error-recovery paths (a wedged send, a missed fire).

## Their world

- Settings, the docs room, and the send's error paths run locally on the demo data (`npm run seed`).
- Most of onboarding is deploy work against a real Cloudflare account and a real email provider, so it runs on staging.

## Journeys

- [Onboarding](onboarding.md), sketch
- [Keep the lights on](keep-the-lights-on.md), sketch
- [Change the app](change-the-app.md), sketch
