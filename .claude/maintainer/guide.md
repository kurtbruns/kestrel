# Writing the setup guide

The setup guide is the documentation for deploying and running your own instance of Kestrel. This file holds the decisions every page follows. The Style section of `.claude/maintainer/frame.md` applies here too. `.claude/CLAUDE.md` mirrors what the guide teaches, so a page that changes what the operator does checks it in the same commit.

## What the guide is

- **For running your own instance.** Deploying, configuring, and upgrading it. How a publisher writes and sends posts is a separate set of docs.
- **Followed by humans and robots alike.** Every page is a complete by-hand procedure that Claude can also follow step by step. Claude is the recommended way through, and any skill that automates a step follows the page rather than replacing it.
- **Run from the reader's own copy of the repository.** It holds the instance's configuration: `origin` is the reader's repository, `upstream` is Kestrel's. Deploys and upgrades happen from it.
- **Local development is optional.** The README owns running Kestrel locally. The guide offers it once as an optional checkpoint after cloning, and once as an optional dry run when upgrading.
- **One environment on the main path: production.** A new instance proves itself with test sends while its list is empty. Staging is a possible guide, not yet in the guide.

## Where it lives

- **One source:** `docs/`, as section folders (`get-started/`, `guides/`, `reference/`) beside SPEC, API, and DESIGN.
- **`docs/README.md` is the landing page and the table of contents.** Its H1 and intro, then a `##` per section with a blurb and a list of the section's pages; a numbered list makes a numbered section. The editor's Docs tab and getkestrel.dev both build their landing and order from it, and GitHub shows it as written. A page that isn't listed there isn't in the guide (a spec holds the two together). No front matter until a rich element needs data the Markdown can't carry.
- **A page's slug** is its file name without the `NN-` prefix, unique across sections.
- **getkestrel.dev is where most people read it**, at the latest release. The editor's Docs tab is the copy matched to the running version, and its landing is the same everywhere.

## Structure

- **Get started:** the main path, numbered: Overview, Deploy the app, Lock the dashboard with Access, Connect Resend, Verify it works, Go live.
- **Guides:** picked from, not read in order: Connect Claude, SES, notifications through Cloudflare's email, rate limiting, upgrading. Possible guides wait as GitHub issues until they've been run end to end, such as staging and the archive on your website.
- **Reference:** the detail and the why: configuration, sending-domain DNS.
- Previous and Next stay within a section.

## Main path defaults

- **Email provider:** Resend. The SES guide replaces step 4.
- **App hostname:** a subdomain, `newsletter.example.com`. The apex works when it has no website of its own; the Overview says so in one sentence.
- **Sending hostname:** `send.example.com`. Phrase it as a recommendation ("It's recommended to send from a subdomain…"), not a prohibition.

## Page anatomy

After Linode's guides:

1. `# Title`: sentence case, a short noun or imperative phrase.
2. **Intro:** what this page does, then "In this guide, you…". One or two short paragraphs.
3. `## Before you begin`: only where a page has prerequisites of its own. List what the reader needs as noun phrases.
4. `## 1. Verb phrase` sections: one or two sentences of why, then numbered steps.
5. `## Check it`: a checklist the reader, or Claude, can verify. Prefer a check with a concrete result (a URL that answers, a command's output) over "it looks right". A page whose sections are themselves the checks, such as Verify it works, ends with one line instead, rather than restating them.
6. **End** by pointing to the next page.

## Voice

- Second person, present tense: "This step creates…", not "will create". Break the rule only where present tense reads wrong.
- Sentences of 25 words or fewer. Oxford comma. No em dashes.
- Plain words over internal vocabulary: "the public pages readers see", not "the reader surface".
- Recommendations, not commands, where the app doesn't enforce the rule.
- No time estimates.
- Sentence-case headings.

## Commands, output, and placeholders

- Commands in `bash` fences, one task per block. Expected output in a plain fence right after, when its text is stable; otherwise describe it in words. Never invent exact output.
- Placeholders: the example names (`example.com`, `newsletter.example.com`, `send.example.com`); UPPER_SNAKE such as `YOUR_USERNAME` for values only the reader knows; `REPLACE_WITH_…` for ids pasted into config.
- Optional steps start with **(Optional)**.
- Notes and callouts sparingly, and only for what isn't needed to succeed.

## Links

- **Between pages:** relative links to the file, `[Deploy the app](02-deploy.md)` or `[SES](../guides/02-ses.md)`. They work on GitHub, the Worker rewrites them to the Docs tab's routes, and getkestrel.dev's sync rewrites them to its URLs. A spec fails on a link to a page that doesn't exist.
- **Anchors work everywhere:** the Docs tab gives each heading GitHub's id, so `02-deploy.md#check-it` lands on the same heading on GitHub, in the app, and on the site. Link to a section when the reader needs that section.
- **Outside the guide** (the README, provider docs): absolute URLs. They open in a new tab in the app.

## Facts

Ground every provider or platform detail (DNS records, event names, plan limits, prices, commands) in that provider's current documentation, and fix the page when they disagree. A fact that can't be checked is described in words, not stated as exact.
