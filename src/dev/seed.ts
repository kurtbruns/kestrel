/**
 * The local demo dataset: a nature/birdwatching newsletter, "Field Notes".
 *
 * This is dev-only tooling reached through the fake-provider seed route. It exists
 * so a fresh local database looks populated — a back-catalog of sent issues, one
 * scheduled issue with a live countdown, a couple of drafts, and an audience with
 * every subscriber state — without anyone having to hand-write it.
 *
 * The one rule it must not break: a sent issue's archived HTML has to be exactly
 * what a real send would produce (I3/I5). So every issue's frozen bytes come from
 * the SAME `render()` the app uses — never hand-written HTML. Everything else
 * (backdated timestamps, `status='sent'` sends, synthetic delivery outcomes) is
 * fixture data the normal write path never produces, which is why the inserts go
 * through the seed-only helpers in `db/seed.ts`.
 */

import type { ImageRow } from "../db/images";
import type { PostRow, RevisionRow } from "../db/posts";
import {
  insertDeliveries,
  insertImage,
  insertPost,
  insertSend,
  insertSubscribers,
  insertSuppressions,
  resetAll,
  type SeedDelivery,
  type SeedSubscriber,
} from "../db/seed";
import { audienceEmails } from "../db/subscribers";
import type { AppEnv, Config } from "../env";
import { newId } from "../lib/ids";
import { probeImageDimensions } from "../lib/image_dims";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const HOUR = 60 * 60 * 1000;

/** The kestrel issue's post id is fixed so the cover image's storage key is stable
 *  across re-seeds. The cover filename follows whatever file is supplied (jpg, webp,
 *  png, …); when none is, it falls back to this default and the reference 404s until
 *  a file is dropped in. */
const KESTREL_POST_ID = "5eed0001-0000-4000-8000-000000000001";
const DEFAULT_COVER_FILENAME = "kestrel.jpg";

type IssueKind = "sent" | "scheduled" | "draft";

interface Issue {
  id: string;
  slug: string;
  subject: string;
  markdown: string;
  kind: IssueKind;
  /** Backdating: how long ago the issue went out (sent) or was last touched
   *  (draft). `daysAgo` wins over `weeksAgo` when both are set. */
  weeksAgo?: number;
  daysAgo?: number;
  hasCover?: boolean;
}

// --- the issues -------------------------------------------------------------

const ISSUES: Issue[] = [
  {
    id: KESTREL_POST_ID,
    slug: "the-hovering-hunter",
    subject: "The hovering hunter",
    kind: "sent",
    weeksAgo: 10, // the flagship (with the cover photo) — the oldest issue in the archive
    hasCover: true,
    markdown: `# The hovering hunter

There is no mistaking a kestrel at work. Where other falcons chase, the kestrel *waits* — hanging in the air on fast-beating wings, head utterly still, reading the grass below for the twitch of a vole.

![A common kestrel hovering over a meadow](kestrel.jpg)

That stillness has a name: **wind-hovering**. The bird faces into the breeze and beats just hard enough to cancel it out, so its eyes stay fixed in space while its body does all the work.

## What to look for

- **Size** — smaller than a pigeon, with long pointed wings and a long tail.
- **Colour** — a warm chestnut back; males add a blue-grey head and tail.
- **Behaviour** — the hover is the giveaway. Nothing else our size holds station like this.

Kestrels can see ultraviolet, which lets them follow the UV-bright urine trails voles leave along their runs — a hidden map laid over an ordinary field.

Next time you pass a motorway verge, look up. That still point over the long grass is very likely this bird.

[More on the common kestrel →](https://en.wikipedia.org/wiki/Common_kestrel)`,
  },
  {
    id: "5eed0002-0000-4000-8000-000000000002",
    slug: "reading-the-autumn-sky",
    subject: "Reading the autumn sky",
    kind: "sent",
    weeksAgo: 3,
    markdown: `# Reading the autumn sky

The first real cold front of autumn does something to the air. Overnight the hedgerows fill with birds that simply weren't there the day before.

## Who's on the move

- **Swallows and martins**, lining the wires before the long haul south.
- **Redwings and fieldfares**, arriving from Scandinavia to strip the berries.
- **Skeins of geese**, low and loud at first light.

Migration isn't a single event so much as a river — a few nights of hard passage, then a lull, then another push when the wind turns kind.

Grab a flask, find a gap in the treeline, and give the sky twenty quiet minutes. This is the season that rewards standing still.`,
  },
  {
    id: "5eed0004-0000-4000-8000-000000000004",
    slug: "field-notes",
    subject: "Field Notes",
    kind: "sent",
    weeksAgo: 8,
    markdown: `# Welcome to the hedgerow

Thanks for being here. **Field Notes** is a short letter about paying closer attention to the wildlife on your own doorstep — no rare-bird chasing required.

Every issue is one idea you can use on your next walk:

- something to **look** for,
- something to **listen** for,
- and one small fact that makes it stick.

That's the whole plan. No apps to buy, no life list to keep — just a standing invitation to slow down for twenty minutes and notice what's already there.

See you in the next one.`,
  },
  {
    id: "5eed0005-0000-4000-8000-000000000005",
    slug: "waxwings-and-fieldfares",
    subject: "Waxwings and fieldfares",
    kind: "scheduled",
    markdown: `# Waxwings and fieldfares

When the berries ripen and the north turns hard, the supermarket car parks fill up — with **waxwings**. These punk-crested wanderers arrive in irruption years to gorge on rowan and cotoneaster, often in the most unglamorous corners of town.

## Worth the detour

- **Waxwings** — trilling flocks, sleek fawn bodies, a flash of yellow and red in the wing.
- **Fieldfares** — bold, chuckling thrushes working the hedges in loose parties.
- **Bramblings** — hiding among the chaffinches under the beeches.

Keep an eye on the berry trees near the shops this month. Some of the best winter birding happens where nobody thinks to look.`,
  },
  {
    id: "5eed0006-0000-4000-8000-000000000006",
    slug: "the-secret-life-of-robins",
    subject: "The secret life of robins",
    kind: "draft",
    markdown: `# The secret life of robins

*(Draft — notes toward the next issue.)*

The robin following your spade isn't being friendly; it's being opportunistic. In the woods it does the same thing behind wild boar, waiting for turned earth to expose a meal.

TODO:
- the myth of the "friendly" robin
- why both sexes hold winter territory
- that they'll sing under a streetlight all night`,
  },
  {
    id: "5eed0007-0000-4000-8000-000000000007",
    slug: "the-ethics-of-backyard-feeding",
    subject: "The ethics of backyard feeding",
    kind: "draft",
    markdown: `# The ethics of backyard feeding

*(Draft — still thinking this one through.)*

Feeding garden birds is one of the most popular ways people connect with wildlife — and it isn't automatically harmless. Dirty feeders spread disease; the wrong food does more harm than good.

TODO:
- clean feeders on a schedule (and why)
- what never to put out
- feeding as a supplement, not a dependency`,
  },
];

// --- audience ---------------------------------------------------------------

const NAMED = [
  "ada.finch",
  "rowan.wren",
  "marina.swift",
  "theo.merlin",
  "june.hawthorn",
  "cy.plover",
  "nadia.linnet",
  "oscar.tern",
  "priya.martin",
  "wes.crake",
  "ines.dunnock",
  "gil.pipit",
];

/** Build the full subscriber set: ~50 confirmed, a few pending, a few unsubscribed. */
function buildSubscribers(now: number): SeedSubscriber[] {
  const rows: SeedSubscriber[] = [];
  const push = (
    email: string,
    status: SeedSubscriber["status"],
    createdAt: number,
    confirmedAt: number | null,
    unsubscribedAt: number | null,
  ) => {
    rows.push({
      id: newId(),
      email,
      status,
      // Two independent long, unguessable tokens (confirm is one-shot; unsub is durable).
      confirm_token: newId() + newId(),
      unsub_token: newId() + newId(),
      created_at: createdAt,
      confirmed_at: confirmedAt,
      unsubscribed_at: unsubscribedAt,
    });
  };

  // Confirmed subscribers predate the oldest issue so the history makes sense.
  const confirmedCount = 50;
  for (let i = 0; i < confirmedCount; i++) {
    const created = now - 11 * WEEK + i * (DAY / 2);
    const email =
      i < NAMED.length
        ? `${NAMED[i]}@example.com`
        : `birder.${String(i).padStart(2, "0")}@example.org`;
    push(email, "confirmed", created, created + DAY, null);
  }

  // Pending: subscribed recently, not yet confirmed.
  for (let i = 0; i < 4; i++) {
    const created = now - (i + 1) * DAY;
    push(`pending.${i}@example.com`, "pending", created, null, null);
  }

  // Unsubscribed: were confirmed, then left.
  for (let i = 0; i < 3; i++) {
    const created = now - 9 * WEEK - i * DAY;
    push(
      `former.reader.${i}@example.com`,
      "unsubscribed",
      created,
      created + DAY,
      now - (i + 1) * WEEK,
    );
  }

  return rows;
}

/** Synthesize a realistic spread of per-recipient outcomes for a completed send. */
function buildDeliveries(sendId: string, audience: string[], completedAt: number): SeedDelivery[] {
  return audience.map((email, i): SeedDelivery => {
    const base: SeedDelivery = {
      id: newId(),
      send_id: sendId,
      email,
      status: "accepted",
      provider_id: `fake-seed-${sendId}-${i}`,
      error: null,
      attempts: 1,
      updated_at: completedAt + 60 * 1000,
      event: "delivered",
      event_detail: null,
      event_at: completedAt + HOUR,
    };
    const slot = i % 37;
    if (slot === 5 || slot === 30) {
      return {
        ...base,
        status: "failed",
        provider_id: null,
        error: "SMTP 550 mailbox unavailable",
        attempts: 5,
        event: null,
        event_at: null,
      };
    }
    if (slot === 11) {
      return {
        ...base,
        status: "skipped",
        provider_id: null,
        attempts: 0,
        event: null,
        event_at: null,
      };
    }
    if (slot === 17) {
      return {
        ...base,
        event: "bounced",
        event_detail: "Recipient address rejected (550 5.1.1)",
        event_at: completedAt + 2 * HOUR,
      };
    }
    if (slot === 23) {
      return {
        ...base,
        event: "complained",
        event_detail: "abuse",
        event_at: completedAt + 3 * HOUR,
      };
    }
    return base;
  });
}

// --- render helpers ---------------------------------------------------------

function renderInputFor(
  issue: Issue,
  at: number,
  markdown: string,
): { post: PostRow; revision: RevisionRow } {
  const post: PostRow = {
    id: issue.id,
    slug: issue.slug,
    subject: issue.subject,
    status: issue.kind === "draft" ? "draft" : issue.kind === "scheduled" ? "scheduled" : "sent",
    current_revision: `${issue.id}-rev`,
    created_at: at,
    updated_at: at,
  };
  const revision: RevisionRow = {
    id: `${issue.id}-rev`,
    post_id: issue.id,
    markdown,
    metadata: JSON.stringify({ subject: issue.subject, slug: issue.slug }),
    author: "seed",
    created_at: at,
  };
  return { post, revision };
}

export interface SeedSummary {
  reset: true;
  subscribers: { confirmed: number; pending: number; unsubscribed: number };
  suppressions: number;
  audience: number;
  posts: { sent: number; scheduled: number; draft: number };
  deliveries: number;
  coverImageBytesWritten: boolean;
  urls: { archive: string[]; admin: string };
}

/**
 * Reset the database and load the Field Notes demo dataset. `kestrelFile`, when
 * provided, is written to R2 as the cover image; when absent the issue still
 * references it (so dropping the file in and re-seeding just works) but the bytes
 * will 404 until then.
 */
export async function seedDatabase(
  env: AppEnv,
  config: Config,
  kestrelFile?: { bytes: ArrayBuffer; contentType: string; filename: string },
): Promise<SeedSummary> {
  const db = env.DB;
  const now = Date.now();

  await resetAll(db);

  // Audience first, so recipient counts and deliveries are grounded in real rows.
  const subscribers = buildSubscribers(now);
  await insertSubscribers(db, subscribers);

  // One suppression shadows a confirmed subscriber (so the audience is confirmed
  // MINUS suppressed, I1); the other is an outside address that hard-bounced.
  const suppressedConfirmed = unwrap(
    subscribers.find((s) => s.status === "confirmed"),
    "confirmed subscriber",
  ).email;
  await insertSuppressions(db, [
    {
      email: suppressedConfirmed,
      reason: "complaint",
      detail: "marked as spam",
      created_at: now - 2 * WEEK,
    },
    {
      email: "bounced.address@example.net",
      reason: "bounce",
      detail: "550 no such user",
      created_at: now - 4 * WEEK,
    },
  ]);

  const audience = await audienceEmails(db); // the authoritative confirmed-minus-suppressed list

  // Cover image: use the supplied file's own name (so a .webp stays a .webp), write
  // the bytes if given, and record the row either way so the rendered issue resolves
  // the reference. R2 serves back whatever content type we store — browsers render
  // webp, png, gif and jpeg alike, so any of them works for the cover.
  const coverFilename = kestrelFile?.filename || DEFAULT_COVER_FILENAME;
  const coverKey = `posts/${KESTREL_POST_ID}/${coverFilename}`;
  const coverDims = kestrelFile ? probeImageDimensions(new Uint8Array(kestrelFile.bytes)) : null;
  const coverRow: ImageRow = {
    id: newId(),
    post_id: KESTREL_POST_ID,
    filename: coverFilename,
    storage_key: coverKey,
    content_type: kestrelFile?.contentType || "image/jpeg",
    width: coverDims?.width ?? null,
    height: coverDims?.height ?? null,
    created_at: now,
  };
  let coverImageBytesWritten = false;
  if (kestrelFile) {
    await env.MEDIA.put(coverKey, kestrelFile.bytes, {
      httpMetadata: { contentType: coverRow.content_type },
    });
    coverImageBytesWritten = true;
  }
  const coverImages: ImageRow[] = [coverRow];

  const counts = {
    sent: 0,
    scheduled: 0,
    draft: 0,
    deliveries: 0,
  };
  const archiveUrls: string[] = [];

  for (const issue of ISSUES) {
    const images = issue.hasCover ? coverImages : [];
    // Point the cover reference at the actual cover filename (e.g. kestrel.webp).
    const markdown = issue.hasCover
      ? issue.markdown.replace("kestrel.jpg", coverFilename)
      : issue.markdown;

    if (issue.kind === "draft") {
      const at = now - (issue.daysAgo ?? 2) * DAY;
      const { post, revision } = renderInputFor(issue, at, markdown);
      await insertPost(db, post, revision);
      counts.draft++;
      continue;
    }

    if (issue.kind === "scheduled") {
      const at = now;
      const fireAt = now + 2 * DAY;
      const { post, revision } = renderInputFor(issue, at, markdown);
      const result = render({ post, revision, images }, config);
      await insertPost(db, post, revision);
      await insertSend(db, {
        id: newId(),
        post_id: issue.id,
        status: "scheduled",
        fire_at: fireAt,
        rendered_html: result.html,
        rendered_text: result.text,
        subject: result.subject,
        recipient_count: audience.length,
        scheduled_at: at,
        started_at: null,
        completed_at: null,
      });
      counts.scheduled++;
      continue;
    }

    // sent
    const ago = issue.daysAgo != null ? issue.daysAgo * DAY : (issue.weeksAgo ?? 1) * WEEK;
    const completedAt = now - ago;
    const fireAt = completedAt - 30 * 1000; // fired, then completed half a minute later
    const scheduledAt = fireAt - DAY; // scheduled a day ahead of the send
    const { post, revision } = renderInputFor(issue, completedAt, markdown);
    const result = render({ post, revision, images }, config);
    await insertPost(db, post, revision);
    if (issue.hasCover) {
      await insertImage(db, coverRow);
    }
    const sendId = newId();
    await insertSend(db, {
      id: sendId,
      post_id: issue.id,
      status: "sent",
      fire_at: fireAt,
      rendered_html: result.html,
      rendered_text: result.text,
      subject: result.subject,
      recipient_count: audience.length,
      scheduled_at: scheduledAt,
      started_at: fireAt,
      completed_at: completedAt,
    });
    const deliveries = buildDeliveries(sendId, audience, completedAt);
    await insertDeliveries(db, deliveries);
    counts.sent++;
    counts.deliveries += deliveries.length;
    archiveUrls.push(`${config.archiveOrigin}${config.archiveBasePath}/${issue.slug}`);
  }

  return {
    reset: true,
    subscribers: { confirmed: 50, pending: 4, unsubscribed: 3 },
    suppressions: 2,
    audience: audience.length,
    posts: { sent: counts.sent, scheduled: counts.scheduled, draft: counts.draft },
    deliveries: counts.deliveries,
    coverImageBytesWritten,
    urls: { archive: archiveUrls, admin: `${config.appOrigin}/admin/` },
  };
}
