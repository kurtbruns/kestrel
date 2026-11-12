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
- **Local development is optional.** The README's Try it locally section covers it, from an empty folder with no Cloudflare account or Git host, since it's for someone deciding whether to use Kestrel. Deploy offers it as an optional step after `init`, and upgrading offers it once as an optional dry run. CONTRIBUTING.md covers running Kestrel's own source, for working on Kestrel.
- **Whose "your".** In Self-hosting, "you" is whoever sets the instance up, and "your" is kept for what's theirs: the accounts, the domain, the repository, the From address. The newsletter's things take "the" (the list, the posts, the publication). Whoever writes and sends the newsletter is "the publisher", which the Self-hosting index defines once as possibly the reader; a setup choice that is theirs, such as the reply inbox or the notifications address, names them.
- **One environment on the main path: production.** A new instance proves itself with test sends while its list is empty.

## Where it lives

- **One source:** `docs/`, as folders (`publishing/`, `get-started/`, `guides/`, `reference/`) beside SPEC, API, and DESIGN.
- **Each set's index file is its landing page and table of contents:** `docs/publishing/README.md` for Publishing, `docs/README.md` for Self-hosting. Its H1 and an intro that links the other set, then a `##` per section with a blurb and a list of the section's pages; a numbered list makes a numbered section. A section's id is its heading's anchor. The editor's Docs tab and getkestrel.dev build their landings and order from them, showing each list item that links a page as a card, so an item with no link, and a blurb's mention of it, is read only in the Markdown; getkestrel.dev parses them with a sync script of its own, so a change to their format is a change for the site too (`.claude/rules/release.md` lists what it relies on). Agents read them raw (`GET /api/docs/publishing.md`), so each must read well as plain Markdown. A page that isn't listed in an index isn't in the docs (a spec holds the two together). No front matter until a rich element needs data the Markdown can't carry.
- **A page's file name is its slug,** with no number: the index sets the order, so adding or moving a page renames nothing. The slug is unique across both sets and distinct from the sets' ids (`publishing`, `self-hosting`), since all of them name routes of one shape: `#/docs/<name>` and `GET /api/docs/<name>.md`.
- **getkestrel.dev is where most people read it**, at the latest release. The editor's Docs tab is the copy matched to the running version, and its landing is the same everywhere.

## Structure

- **Publishing:** the Docs tab opens on it, since it's read once Kestrel is running, mostly by the publisher. Three sections. **Set up your publication**, numbered, follows the dashboard's setup steps of the same name step for step and word for word: Connect Amazon SES, Send a test email, Name your publication, Set the time zone, Get notified, Request production access, Bring your existing list, Write your first post, Schedule your first post, Send a test email for your first post, Share your subscribe link. A step links the page that covers it only when it's the publisher's and no earlier step links that page, so each page is linked once, since a link in the list is what puts a page in the section (getkestrel.dev's sync also drops an item whose link has an anchor): Name your publication links its page, which also covers Set the time zone; Get notified links its own; Write your first post links Write and send a post, which also covers scheduling and the first post's test; and the three steps for whoever runs the instance, Connect Amazon SES, Send a test email, and Request production access, link no page, since their pages are the setup guide's (the test is Connect Amazon SES's last step). The section's blurb speaks to the publisher, says the steps follow the instance's deployment, and links Self-hosting rather than those pages, so it reads true both as the landing's cards, which show only the linked steps, and as the Markdown's full list. Once a post exists the same steps are the dashboard's Finish setting up card, until the first post listed in the archive is published. A change to those steps changes this section, the pages it links that name a step, and the other copies `.claude/rules/maintainer.md`'s table names, this list among them. Nothing checks them against the dashboard: a spec checks only that no page in a section is linked twice or with an anchor. **Go further**, what a publisher chooses to do once running (Edit your email template, Connect Claude, which ends with what to ask Claude and the lines the app holds). **Rules and troubleshooting**, what they look up when they need it (Sending rules, and Troubleshooting, which opens with a table of symptoms and where each fix is, takes the publisher's questions, says where on screen the app explains each problem, and keeps only what the screen can't say: the fixes made outside Kestrel, and the decisions; a section whose fix is outside Kestrel ends as the app's own lines do, "If someone else set up Kestrel for you, pass this along to them."; a failure met during setup belongs on that setup step, not here; any words it quotes from the app, a spec holds to the source). The three match why someone opens the docs: to get going, to do more, or to look something up. The template has its own page since it's optional and holds a reference table; Name your publication says in a paragraph what it does and links it. The import format is the last section of Bring your existing list, The file format, because it serves that page's goal, and publishers and Claude converting a list for them are its readers. A legal question that comes up at one setting, such as whether you need a mailing address, is answered on that setting's page, where Settings links it; Sending rules holds the rest.
- **Get started:** the main path, numbered: Deploy the app, Lock the dashboard with Access, Create an AWS account, Connect Amazon SES, Request production access, Verify it works, Go live. Go live is a fork, not a procedure, a checkpoint that orients the reader on where to go next, by who's writing the newsletter: the reader, who opens the editor and Publishing, or someone else, who gets let in and handed the editor's address and Publishing (never restating Publishing's steps). Then the optional guides, each named by when to reach for it. How to let someone else in is the Access page's, unnumbered after its checks, since the main path doesn't need it. Checks that the instance is ready belong in Verify it works, which runs wholly in the sandbox and says so, and only checks, never sets anything up. Its Read the logs is one check that shows where the logs are (finding the send it made, and an error filter that shows nothing), not a second pass over what the other sections proved, and not a catalog of events: the log lines name themselves, so a list here would be a copy of the event catalog that nothing checks. The path stops at a reasonable checkpoint, an instance proven to send, and what adds to it is a guide. Set up alerts, the two Cloudflare alerts for what Kestrel's own emails can't report, is the first of Go live's optional guides, named for before anyone relies on the newsletter: it opens by saying what the alerts are for and what they cost, then that it is optional and recommended for any newsletter people rely on, and what is lost without it, and Go live speaks of the alerts as ones the reader may not have made. Production access is the exception: its own page, after Connect Amazon SES has proven the sandbox connection and before Verify it works, both requests it and, as its last section, checks the grant, and Go live opens by pointing there, since a reader may reach it while AWS is still deciding. So AWS reviews a live site, and its wait overlaps Verify it works. Create an AWS account is on the path, not a guide, since the path assumes a brand-new setup; it says plainly what sharing an account across publications costs, as advice rather than a rule, and a reader using an account they already have skips the page, and Deploy the app's Before you begin says to start it early, since AWS can take a while to activate an account. There is no overview page: what the whole path needs opens Deploy the app as its Before you begin, and the docs landing lists the steps.
- **Guides:** picked from, not read in order: Allow Claude to connect (Managed OAuth, so a publisher can connect Claude as themselves; the publisher's Connect Claude page covers connecting, from Claude Desktop, claude.ai, or Claude Code), Set up alerts, rate limiting, upgrading to a new release, growing your list (raising SES limits and upgrading to Workers Paid, the one page every limit links to), Automate with a service token (for scripts and jobs with no one present). They are ordered by how likely a publisher who stays with Kestrel is to need each, then by when: launch-day guides before later ones, and a certain one (upgrading) before ones that depend on circumstances. The docs landing and Go live list them in that one order. A guide's file name is still a published path: every instance's upgrade skill reads the upgrade guide by its file name in the installed package, so renaming that page needs a stub at the old name for a release, as `.claude/rules/release.md` says. Possible guides wait as GitHub issues until they've been run end to end, such as the archive on your website.
- **Reference:** the detail and the why: configuration, sending-domain DNS.
- Previous and Next stay within a section.
- **Self-hosting's index** links Publishing in its intro, and Publishing's links Self-hosting, so either is one link from the other.

## Publishing pages

The Publishing set gets a publisher going, and tells them about the decisions to make or be aware of before they hit them. Its reader is the publisher, who may or may not also manage the instance. Write simply and well, and be technical where the precise term is the technical one; never talk down.

- **Each page has one goal,** a task the publisher does or a question they bring. A page whose content serves another page's goal belongs in that page, as a later section.
- **Answer first.** The page, and a section a link lands on, opens with the short answer: what to do, and where to click, by the dashboard's own words in bold (**Subscribers → Import**). No page overview, Before you begin, or Check it, and numbered sections only where the task is a sequence, as a migration is.
- **A decision that comes before the work comes right after the answer,** in bold, such as upgrading to Workers Paid before importing a large list. When it's a change to the deployment, link the setup guide page that makes it.
- **Only what changes what the publisher does.** The dashboard explains itself as they go, so a page doesn't walk it screen by screen. Exact rules, edge cases, and the API go in a reference section at the page's end, under its own heading, or in the API reference.
- **Each fact once.** One page holds it, and the others link there in a line.
- **Short.** The task part of a page fits in a screen or two.
- **No closing "Next" line.** A publisher picks a page from the index or follows a link to it, rather than reading the set in order, and the Docs tab's pager links the next page anyway.
- **Facts come from the app, not the documents alone.** Check a label against the UI's source as well as DESIGN, and a behavior against the code as well as SPEC. Where they disagree, describe what the app does and flag the gap to the maintainer.
- **Say what to do, not who does it.** The reader may also manage the instance, so a change that belongs to the deployment says what to do and links the setup guide page that does it, never restating it. Name the provider's own product (Cloudflare's Workers Paid plan, Amazon SES), so a search finds it. Never assume the reader has used wrangler or a terminal.
- **Settled facts, cited and hedged.** A legal claim links its source and says whose law it is. Where the law is judgment, say "usually" or "probably". A page with legal content says it's general information, not legal advice.
- **One name for each thing.** Kestrel is the app and what it does ("Kestrel emails you"). Your publication is what the publisher puts out, its identity and its address (`newsletter.example.com`, which the dashboard's Publication card shows). Your instance is where it runs, for setup someone else may do: its Access application, its repository, its settings; a page introduces it once as "your Kestrel instance". Whoever makes a setup change is "whoever runs your instance". Never "your Kestrel", "the deployment", or "application", which the setup guide uses for the Access application. "Your newsletter" is fine for the emails readers get.
- **Troubleshooting bolds only Kestrel's own labels.** A spec holds each bold label and each "…" quote on that page to the app's source, so another product's control, such as the SES console's account dashboard, is named there in plain words.
- **Headings are link targets.** The editor links a section by its heading's exact words, and a spec fails when a linked heading changes, so rename a linked heading only with its links.

## Main path defaults

- **Email provider:** Amazon SES, the only provider the guide covers. The Connect Amazon SES step walks through it.
- **App hostname:** a subdomain, `newsletter.example.com`. The apex works when it has no website of its own; Deploy the app says so in one sentence, in its Choose your hostnames section.
- **Sending hostname:** `send.example.com`. Phrase it as a recommendation ("It's recommended to send from a subdomain…"), not a prohibition.

## Page anatomy

A setup guide page, after Linode's guides:

1. `# Title`: sentence case, a short noun or imperative phrase.
2. **Intro:** what this page does, then "In this guide, you…". One or two short paragraphs.
3. `## Before you begin`: only where a page has prerequisites of its own. List what the reader needs as noun phrases. Deploy the app also carries an unnumbered `## Choose your hostnames` after it, since the whole path uses those names.
4. `## 1. Verb phrase` sections: one or two sentences of why, then numbered steps. Where what a section set up can be seen, its last step checks it, with a concrete result, so a mistake shows where it was made, as in Linode's guides.
5. `## Check it`: a checklist the reader, or Claude, can verify. Prefer a check with a concrete result (a URL that answers, a command's output) over "it looks right". A failure readers really meet, and that nothing on screen explains, gets one sentence beside the check, tied to what the reader can see ("If `curl` can't resolve the host, …"), rather than a link to Troubleshooting, which is the publisher's page. Leave out what's hypothetical, harmless, or said nearby: a reader whose step worked reads past every line. A page whose sections each end with their own check, such as Connect Amazon SES, or are themselves the checks, such as Verify it works, ends with one line instead, rather than restating them.
6. **End** by pointing to the next page, on Get started's numbered path. Claude follows that path as Markdown, where the line is the only way on. A guide, picked from the landing, needs none.

## Voice

- Second person, present tense: "This step creates…", not "will create". Break the rule only where present tense reads wrong.
- Sentences of 25 words or fewer. Oxford comma. No em dashes. No rhetorical questions: state the condition ("If you're starting fresh, …").
- Plain words over internal vocabulary: "the public pages readers see", not "the reader surface".
- Recommendations, not commands, where the app doesn't enforce the rule.
- No time estimates.
- Sentence-case headings.

## Commands, output, and placeholders

- Commands in `bash` fences, one task per block. Expected output in a plain fence right after, when its text is stable; otherwise describe it in words. Never invent exact output.
- Code is never a link: link the words around it, or use words in place of the code.
- Code is never bold. A list that explains settings or values leads each item with the code alone (`` - `routes` puts the app… ``); its chip already sets it apart.
- Placeholders: the example names (`example.com`, `newsletter.example.com`, `send.example.com`); UPPER_SNAKE such as `YOUR_USERNAME` for values only the reader knows; `REPLACE_WITH_…` for ids pasted into config.
- Optional steps start with **(Optional)**.
- Notes and callouts sparingly, and only for what isn't needed to succeed.

## Links

- **Between pages:** relative links to the file, `[Deploy the app](deploy.md)` or `[Upgrade to a new release](../guides/upgrade.md)`. They work on GitHub, the Worker rewrites them to the Docs tab's routes, and getkestrel.dev's sync rewrites them to its URLs. A spec fails on a link to a page that doesn't exist.
- **Anchors work everywhere:** the Docs tab gives each heading GitHub's id, so `deploy.md#check-it` lands on the same heading on GitHub, in the app, and on the site. Link to a section when the reader needs that section.
- **A section of Settings:** name it in bold by the dashboard's words, **Settings → Notifications**, never as a link. The Docs tab links the name to that section, while GitHub, getkestrel.dev, and an agent's copy, which have no dashboard to open, keep plain words. A spec fails on a name that matches no section.
- **Outside the guide** (the README, provider docs): absolute URLs. They open in a new tab in the app.

## Facts

Ground every provider or platform detail (DNS records, event names, plan limits, prices, commands) in that provider's current documentation, and fix the page when they disagree. A fact that can't be checked is described in words, not stated as exact.
