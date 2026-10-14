---
paths:
  - "docs/README.md"
  - "docs/get-started/**"
  - "docs/guides/**"
  - "docs/reference/**"
  - "docs/publishing/**"
  - "src/docs/**"
---

# Writing the docs

The docs are two sets, each with its own landing: **Publishing** (`docs/publishing/`), for the publisher who writes and sends the newsletter, and **Self-hosting**, the setup guide (Get started, Guides, Reference), for deploying and running your own instance of Kestrel. This file holds the decisions every page follows; Publishing pages, below, says where a publisher's page differs. The style rules in `.claude/rules/maintainer.md` apply here too.

## What the setup guide is

- **The setup guide is for running your own instance.** Deploying, configuring, and upgrading it. How a publisher writes and sends posts is the Publishing set, `docs/publishing/`.
- **Followed by humans and robots alike.** Every page is a complete by-hand procedure that Claude can also follow step by step. Claude is the recommended way through, and any skill that automates a step follows the page rather than replacing it.
- **Run from the reader's instance repository.** `kestrel init` writes it: the instance's configuration, its migrations, and the Kestrel release it runs, installed from npm as `@kurtbruns/kestrel`. Deploys and upgrades happen from it, through its npm scripts and plain wrangler commands (`npx wrangler deploy --env production`), never through a checkout of Kestrel's source. Changing Kestrel's code for one instance is not covered.
- **Local development is optional.** The Try Kestrel locally first guide covers it, from an empty folder with no Cloudflare account or Git host; Deploy points to it as an optional checkpoint after `init`, and upgrading offers it once as an optional dry run. The README covers running Kestrel's own source, for working on Kestrel.
- **One environment on the main path: production.** A new instance proves itself with test sends while its list is empty. Staging is a possible guide, not yet in the guide.

## Where it lives

- **One source:** `docs/`, as folders (`publishing/`, `get-started/`, `guides/`, `reference/`) beside SPEC, API, and DESIGN.
- **Each set's index file is its landing page and table of contents:** `docs/publishing/README.md` for Publishing, `docs/README.md` for Self-hosting. Its H1 and an intro that links the other set, then a `##` per section with a blurb and a list of the section's pages; a numbered list makes a numbered section. A section's id is its heading's anchor. The editor's Docs tab and getkestrel.dev build their landings and order from them. Agents read them raw (`GET /api/docs/publishing.md`), so each must read well as plain Markdown. A page that isn't listed in an index isn't in the docs (a spec holds the two together). No front matter until a rich element needs data the Markdown can't carry.
- **A page's slug** is its file name without the `NN-` prefix, unique across both sets and distinct from the sets' ids (`publishing`, `self-hosting`), since all of them name routes of one shape: `#/docs/<name>` and `GET /api/docs/<name>.md`.
- **getkestrel.dev is where most people read it**, at the latest release. The editor's Docs tab is the copy matched to the running version, and its landing is the same everywhere.

## Structure

- **Publishing:** the Docs tab opens on it, since it's read once Kestrel is running, mostly by the publisher. Three sections. **Set up your publication**, numbered, follows the dashboard's first-run checklist of the same name step for step and word for word: Name your publication, Check your setup, Bring your existing list, Write your first post, Share your subscribe link. While no provider is connected, the dashboard's second step is Connect Amazon SES instead, the operator's, and Check your setup says so and links it. A change to that checklist changes this section. **Sending** (Scheduling and sending, After a send, Sending rules). **More** (Working with Claude, the import format). The import format lives here because publishers, and Claude converting a list for them, are its readers. A legal question that comes up at one setting, such as whether you need a mailing address, is answered on that setting's page, where Settings links it; Sending rules holds the rest.
- **Get started:** the main path, numbered: Deploy the app, Lock the dashboard with Access, Connect Amazon SES, Verify it works, Go live. There is no overview page: what the whole path needs opens Deploy the app as its Before you begin, and the docs landing lists the steps.
- **Guides:** picked from, not read in order: Connect Claude, trying Kestrel locally first, notifications through Cloudflare's email, rate limiting, upgrading. The docs landing's list sets the order, not the file prefixes. Possible guides wait as GitHub issues until they've been run end to end, such as staging and the archive on your website.
- **Reference:** the detail and the why: configuration, sending-domain DNS.
- Previous and Next stay within a section.
- **Self-hosting's index** links Publishing in its intro, and Publishing's links Self-hosting, so either is one link from the other.

## Publishing pages

A publisher's page is a task page, not a procedure, and it works for a writer someone else set Kestrel up for.

- **Answer first.** The page, and a section a link lands on, opens with the short answer, then the reasons. No Before you begin, numbered steps, or Check it.
- **Shape:** what it's for; what Kestrel does and what you do; where to click, by the dashboard's own words in bold (**Subscribers → Import**); the limits; links onward.
- **Facts come from the app, not the documents alone.** Check a label against the UI's source as well as DESIGN, and a behavior against the code as well as SPEC. Where they disagree, describe what the app does and flag the gap to the maintainer.
- **No deploy vocabulary.** Never assume the reader touched Cloudflare, wrangler, or AWS. A fact that belongs to whoever deploys (Workers Paid, reply forwarding, the From address) is named as theirs, "whoever runs your Kestrel", with a link into the setup guide for the detail, never restated.
- **Settled facts, cited and hedged.** A legal claim links its source and says whose law it is. Where the law is judgment, say "usually" or "probably". A page with legal content says it's general information, not legal advice.
- **Headings are link targets.** The editor links a section by its heading's exact words, and a spec fails when a linked heading changes, so rename a linked heading only with its links.

## Main path defaults

- **Email provider:** Amazon SES, the only provider the guide covers. Step 3, Connect Amazon SES, walks through it.
- **App hostname:** a subdomain, `newsletter.example.com`. The apex works when it has no website of its own; Deploy the app says so in one sentence, in its Choose your hostnames section.
- **Sending hostname:** `send.example.com`. Phrase it as a recommendation ("It's recommended to send from a subdomain…"), not a prohibition.

## Page anatomy

A setup guide page, after Linode's guides:

1. `# Title`: sentence case, a short noun or imperative phrase.
2. **Intro:** what this page does, then "In this guide, you…". One or two short paragraphs.
3. `## Before you begin`: only where a page has prerequisites of its own. List what the reader needs as noun phrases. Deploy the app also carries an unnumbered `## Choose your hostnames` after it, since the whole path uses those names.
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

- **Between pages:** relative links to the file, `[Deploy the app](02-deploy.md)` or `[Notifications](../guides/03-notifications.md)`. They work on GitHub, the Worker rewrites them to the Docs tab's routes, and getkestrel.dev's sync rewrites them to its URLs. A spec fails on a link to a page that doesn't exist.
- **Anchors work everywhere:** the Docs tab gives each heading GitHub's id, so `02-deploy.md#check-it` lands on the same heading on GitHub, in the app, and on the site. Link to a section when the reader needs that section.
- **Outside the guide** (the README, provider docs): absolute URLs. They open in a new tab in the app.

## Facts

Ground every provider or platform detail (DNS records, event names, plan limits, prices, commands) in that provider's current documentation, and fix the page when they disagree. A fact that can't be checked is described in words, not stated as exact.
