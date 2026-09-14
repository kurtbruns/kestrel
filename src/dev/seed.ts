/**
 * The local demo dataset: a nature/birdwatching newsletter, "Windbreak", seeded
 * as a publication that has been running for a few months — not a thin static snapshot.
 *
 * It models a chronological lifecycle so the app's states are actually exercised:
 * an initial import of already-confirmed subscribers backdated before the first issue,
 * three completed sends spread over time, and — in between — new confirmations (the
 * list grows) and unsubscribes (the list churns), plus a hard bounce and a spam
 * complaint that become suppressions. The upshot is that every completed send freezes
 * the audience AS IT WAS at that moment: someone who unsubscribes after issue #2 is
 * still recorded as mailed by issues #1–#2, and a later suppression shadows the current
 * audience (confirmed − suppressed = mailable, I1) without rewriting any past send.
 *
 * Two rules it must not break:
 *  - A sent issue's archived HTML is exactly what a real send would produce (I3/I5),
 *    so every issue's frozen bytes come from the SAME `render()` the app uses — never
 *    hand-written HTML.
 *  - It is deterministic: names, emails, timestamps and per-recipient outcomes are all
 *    derived from position on the timeline (no `Math.random()`), so a re-seed reproduces
 *    the same shape. Only opaque ids/tokens use `crypto`; they never change what the data
 *    means.
 *
 * Everything here (backdated timestamps, `status='sent'` sends, frozen per-send audiences,
 * synthetic delivery outcomes) is fixture data the normal write path never produces, which
 * is why the inserts go through the seed-only helpers in `db/seed.ts`.
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
  type SeedSuppression,
} from "../db/seed";
import { BRANDING_LOGO_KEY, getSettings, setPublicationLogo, updateSettings } from "../db/settings";
import { audienceEmails } from "../db/subscribers";
import type { AppEnv, Config } from "../env";
import { newId, newToken } from "../lib/ids";
import { probeImageDimensions } from "../lib/image_dims";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";
import { resolveBranding } from "../render/template_engine";

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
  /** Sent issues only: which completed send on the timeline this is (0 = oldest).
   *  The send time and the frozen audience both come from that timeline slot. */
  sentIndex?: number;
  /** Draft issues only: how long ago the draft was last touched. */
  daysAgo?: number;
  hasCover?: boolean;
}

// --- the issues -------------------------------------------------------------

const ISSUES: Issue[] = [
  {
    id: "5eed0004-0000-4000-8000-000000000004",
    slug: "welcome-to-windbreak",
    subject: "Welcome to Windbreak",
    kind: "sent",
    sentIndex: 0, // the launch issue — the oldest in the archive
    markdown: `# Welcome to the hedgerow

Thanks for being here. **Windbreak** is a short letter about paying closer attention to the wildlife on your own doorstep — no rare-bird chasing required.

Every issue is one idea you can use on your next walk:

- something to **look** for,
- something to **listen** for,
- and one small fact that makes it stick.

That's the whole plan. No apps to buy, no life list to keep — just a standing invitation to slow down for twenty minutes and notice what's already there.

See you in the next one.`,
  },
  {
    id: KESTREL_POST_ID,
    slug: "the-hovering-hunter",
    subject: "The hovering hunter",
    kind: "sent",
    sentIndex: 1, // the flagship, with the cover photo
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
    slug: "autumn-skies",
    subject: "Autumn skies",
    kind: "sent",
    sentIndex: 2, // the most recent send
    markdown: `# Autumn skies

The first real cold front of autumn does something to the air. Overnight the hedgerows fill with birds that simply weren't there the day before.

## Who's on the move

- **Swallows and martins**, lining the wires before the long haul south.
- **Redwings and fieldfares**, arriving from Scandinavia to strip the berries.
- **Skeins of geese**, low and loud at first light.

Migration isn't a single event so much as a river — a few nights of hard passage, then a lull, then another push when the wind turns kind.

Grab a flask, find a gap in the treeline, and give the sky twenty quiet minutes. This is the season that rewards standing still.`,
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
    daysAgo: 2,
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
    daysAgo: 6,
    markdown: `# The ethics of backyard feeding

*(Draft — still thinking this one through.)*

Feeding garden birds is one of the most popular ways people connect with wildlife — and it isn't automatically harmless. Dirty feeders spread disease; the wrong food does more harm than good.

TODO:
- clean feeders on a schedule (and why)
- what never to put out
- feeding as a supplement, not a dependency`,
  },
];

// --- the timeline -----------------------------------------------------------

/** Absolute epoch-ms anchors for the seeded lifecycle, all relative to `now` so a
 *  re-seed keeps the same shape and the scheduled issue always fires in the future.
 *
 *  Read as a story from the top: the list is imported, issue #1 goes out, the list
 *  grows and sheds a few readers, issue #2 goes out (and draws a bounce and a
 *  complaint just after), it grows again, then issue #3 goes out. */
interface Timeline {
  now: number;
  importAt: number;
  growthAAt: number; // confirmations arriving between #1 and #2
  bounceAt: number; // hard bounce reported just after #2
  complaintAt: number; // spam complaint reported just after #2
  growthBAt: number; // confirmations arriving between #2 and #3
  scheduledFireAt: number;
  /** The three completed sends, oldest first — indexed by `Issue.sentIndex`.
   *  Each also anchors the wave of unsubscribes it prompts (see `unsubAfter`). */
  sentAt: [number, number, number];
}

export function buildTimeline(now: number): Timeline {
  const send2At = now - 7 * WEEK;
  return {
    now,
    importAt: now - 14 * WEEK,
    growthAAt: now - 10 * WEEK,
    bounceAt: send2At + DAY,
    complaintAt: send2At + 2 * DAY,
    growthBAt: now - 5 * WEEK,
    scheduledFireAt: now + 2 * DAY,
    sentAt: [now - 12 * WEEK, send2At, now - 3 * WEEK],
  };
}

/** When a reader in a churn wave unsubscribes: a spike just after the issue that
 *  prompted them, tapering off over the following days. The quadratic step front-loads
 *  the wave (member 0 leaves within hours, later members trickle out over ~1–2 weeks)
 *  while keeping every offset inside the gap before the next send — so the wave stays
 *  attributed to the issue it followed and the frozen per-send audiences don't shift. */
function unsubscribedAfter(sentAt: number, indexInWave: number): number {
  return sentAt + 6 * HOUR + indexInWave * indexInWave * 8 * HOUR;
}

// --- audience ---------------------------------------------------------------

const FIRST_NAMES = [
  "ada",
  "rowan",
  "marina",
  "theo",
  "june",
  "cy",
  "nadia",
  "oscar",
  "priya",
  "wes",
  "ines",
  "gil",
  "mabel",
  "otis",
  "lena",
  "hugo",
  "sasha",
  "dov",
  "clara",
  "felix",
  "noor",
  "bram",
  "elsie",
  "kai",
  "rosa",
  "sam",
  "tessa",
  "viktor",
  "mira",
  "yusuf",
];
const LAST_NAMES = [
  "finch",
  "swift",
  "merlin",
  "hawthorn",
  "plover",
  "linnet",
  "tern",
  "martin",
  "crake",
  "dunnock",
  "pipit",
  "sparrow",
  "kestrel",
  "heron",
  "robin",
  "teal",
  "snipe",
  "curlew",
  "brambling",
  "siskin",
  "redwing",
  "fieldfare",
  "waxwing",
  "thrush",
  "warbler",
  "starling",
  "swallow",
  "jay",
  "rook",
  "wren",
];
const DOMAINS = ["example.com", "example.org", "example.net", "example.co"];

/** A deterministic, collision-free address from a global index. Both name parts advance
 *  every row (so no cohort clusters on one surname), while the pair stays unique: the
 *  first index is `n % F` and the last is diagonal, `(n + ⌊n / F⌋) % L`. That is a
 *  bijection over the roster as long as `gcd(F + 1, L) = 1` — which holds for these
 *  equal-length lists (F = L = 30, and 31 is coprime to 30). */
function emailFor(n: number): string {
  const first = FIRST_NAMES[n % FIRST_NAMES.length];
  const last = LAST_NAMES[(n + Math.floor(n / FIRST_NAMES.length)) % LAST_NAMES.length];
  const domain = DOMAINS[n % DOMAINS.length];
  return `${first}.${last}@${domain}`;
}

interface BuiltAudience {
  subscribers: SeedSubscriber[];
  suppressions: SeedSuppression[];
  /** The mailable audience frozen at each completed send (sorted emails), oldest first. */
  sentAudiences: [string[], string[], string[]];
  /** The bounce/complaint webhook events attributed to send #2 (reported just after it,
   *  and the source of this dataset's suppressions), keyed by recipient email. Applied to
   *  that send's delivery rows so the record carries the event that shadowed each address. */
  sendTwoEvents: Map<string, DeliveryEvent>;
}

/** A subscriber's status AT A PAST MOMENT `t`, read from the consent timestamps rather
 *  than the final status: confirmed by then, and not yet unsubscribed. */
function isConfirmedAt(s: SeedSubscriber, t: number): boolean {
  return (
    s.confirmed_at != null &&
    s.confirmed_at <= t &&
    (s.unsubscribed_at == null || s.unsubscribed_at > t)
  );
}

/** The mailable audience as it stood at `t`: confirmed then, minus anything already
 *  suppressed then (I1). This is the JS mirror of `audienceEmails` run against a past
 *  moment, which is what lets each completed send freeze the list as it really was. */
function mailableAt(subs: SeedSubscriber[], sups: SeedSuppression[], t: number): string[] {
  const suppressedByThen = new Set(sups.filter((x) => x.created_at <= t).map((x) => x.email));
  return subs
    .filter((s) => isConfirmedAt(s, t) && !suppressedByThen.has(s.email))
    .map((s) => s.email)
    .sort();
}

/**
 * Build the whole audience as a lifecycle: an imported core plus two later growth
 * cohorts, three churn waves that each unsubscribe in the days after an issue lands,
 * a few still-pending sign-ups, and two suppressions (a bounce and a complaint) drawn
 * from the core so they visibly shadow the current audience. The counts are chosen so
 * the mailable audience genuinely fluctuates from send to send (140 → 152 → 159, then
 * 155 now).
 */
function buildAudience(t: Timeline): BuiltAudience {
  let seq = 0;
  const subscribers: SeedSubscriber[] = [];
  const make = (
    status: SeedSubscriber["status"],
    createdAt: number,
    confirmedAt: number | null,
    unsubscribedAt: number | null,
  ): string => {
    const email = emailFor(seq++);
    subscribers.push({
      id: newId(),
      email,
      status,
      // Two independent long, unguessable tokens (confirm is one-shot; unsub is durable).
      confirm_token: newToken(),
      unsub_token: newToken(),
      created_at: createdAt,
      confirmed_at: confirmedAt,
      unsubscribed_at: unsubscribedAt,
    });
    return email;
  };

  // Initial import: already-confirmed addresses migrated in before issue #1 (a real
  // list starts as a bulk import, not one opt-in at a time). Three waves of them later
  // churn out — each wave leaving in the days after the last issue it received, so its
  // members are still mailed by that issue but not the next; the rest are the core that
  // stays. `unsubAfter` is the issue that prompts the wave (null = never leaves).
  const IMPORT = 140;
  const importStep = (10 * DAY) / IMPORT; // spread across ~10 days, all before send #1
  const importPlan: { count: number; unsubAfter: number | null }[] = [
    { count: 125, unsubAfter: null }, // core — never leave
    { count: 6, unsubAfter: t.sentAt[0] }, // wave after #1 — leaves before #2
    { count: 5, unsubAfter: t.sentAt[1] }, // wave after #2 — leaves before #3
    { count: 4, unsubAfter: t.sentAt[2] }, // wave after #3 — still gone today
  ];
  const coreEmails: string[] = [];
  let importIdx = 0;
  for (const group of importPlan) {
    for (let i = 0; i < group.count; i++) {
      const createdAt = Math.round(t.importAt + importIdx * importStep);
      const email = make(
        group.unsubAfter == null ? "confirmed" : "unsubscribed",
        createdAt,
        createdAt, // imported already confirmed
        group.unsubAfter == null ? null : unsubscribedAfter(group.unsubAfter, i),
      );
      if (group.unsubAfter == null) {
        coreEmails.push(email);
      }
      importIdx++;
    }
  }

  // Growth cohort A: confirmed between #1 and #2, so mailed by #2 and #3 but not #1.
  const GROWTH_A = 18;
  for (let i = 0; i < GROWTH_A; i++) {
    const confirmedAt = Math.round(t.growthAAt + (i * (2 * DAY)) / GROWTH_A);
    make("confirmed", confirmedAt - DAY, confirmedAt, null);
  }
  // Growth cohort B: confirmed between #2 and #3, so mailed by #3 only.
  const GROWTH_B = 14;
  for (let i = 0; i < GROWTH_B; i++) {
    const confirmedAt = Math.round(t.growthBAt + (i * (2 * DAY)) / GROWTH_B);
    make("confirmed", confirmedAt - DAY, confirmedAt, null);
  }
  // Still pending: subscribed in the last few days, not yet confirmed — in no audience.
  const PENDING = 5;
  for (let i = 0; i < PENDING; i++) {
    make("pending", t.now - (i + 1) * DAY, null, null);
  }

  // Two core subscribers draw a hard bounce and a spam complaint just after issue #2.
  // Both stay confirmed (suppression is orthogonal to consent, §7) but are suppressed
  // from then on, so they were mailed by #1 and #2 yet shadowed out of #3 and today.
  const bounceEmail = unwrap(coreEmails[3], "core subscriber");
  const complaintEmail = unwrap(coreEmails[9], "core subscriber");
  const suppressions: SeedSuppression[] = [
    {
      email: bounceEmail,
      reason: "bounce",
      detail: "550 5.1.1 user unknown",
      created_at: t.bounceAt,
    },
    {
      email: complaintEmail,
      reason: "complaint",
      detail: "abuse report via feedback loop",
      created_at: t.complaintAt,
    },
  ];

  const sentAudiences = t.sentAt.map((at) => mailableAt(subscribers, suppressions, at)) as [
    string[],
    string[],
    string[],
  ];
  // The bounce and complaint were reported just after issue #2, so their delivery events
  // belong to that send alone (see the loop in seedDatabase).
  const sendTwoEvents = new Map<string, DeliveryEvent>([
    [
      bounceEmail,
      { event: "bounced", detail: "Recipient address rejected (550 5.1.1)", at: t.bounceAt },
    ],
    [complaintEmail, { event: "complained", detail: "abuse", at: t.complaintAt }],
  ]);
  return { subscribers, suppressions, sentAudiences, sendTwoEvents };
}

// --- scaled audience (parametric seed) --------------------------------------

/** Options for a parametric seed. `size` is the approximate confirmed-now list size (an
 *  approximate target, not exact); absent, the curated Windbreak dataset is loaded
 *  unchanged. `seed` makes a given `(size, seed)` reproducible. */
export interface SeedOptions {
  size?: number;
  seed?: number;
}

/** The default PRNG seed, so `--size 1k` alone is reproducible run to run. */
export const DEFAULT_SEED = 0x5eed;

/** A tiny seeded PRNG (mulberry32): a single 32-bit seed drives a reproducible stream of
 *  floats in [0, 1). This replaces the curated list's determinism-by-fixed-index with
 *  reproducible pseudo-randomness, so churn timing, suppression victims, and per-send
 *  failures vary believably while a given `(size, seed)` still reproduces exactly. */
export function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A collision-free, human-plausible address for ANY global index — unbounded, unlike the
 * 3,600-address `emailFor` bijection, so a scaled list can reach 10k/100k. The (first,
 * last) pair uses the same diagonal spread as `emailFor` over its 900 combinations; once
 * those are exhausted the local part gains a cycle number (`ada.finch`, then `ada.finch2`,
 * `ada.finch3`, …), which real mail providers hand out too. (first, last, cycle) is a
 * bijection with `n`, so addresses never collide at any size.
 */
export function scaledEmailFor(n: number): string {
  const F = FIRST_NAMES.length;
  const L = LAST_NAMES.length;
  const pair = n % (F * L); // 0..899 — a unique (first, last) within a cycle
  const cycle = Math.floor(n / (F * L));
  const first = FIRST_NAMES[pair % F];
  const last = LAST_NAMES[(pair + Math.floor(pair / F)) % L];
  const domain = DOMAINS[n % DOMAINS.length];
  const local = cycle === 0 ? `${first}.${last}` : `${first}.${last}${cycle + 1}`;
  return `${local}@${domain}`;
}

/** Cohort proportions and low outcome rates for a scaled list, expressed as fractions of
 *  the approximate confirmed-now `size`. Chosen so the scaled dataset keeps the curated
 *  list's story shape — an imported core, two growth cohorts, a churn wave after each
 *  issue, a small pending tail, and a few suppressions — with realistic percentages at
 *  every size (low bounce/complaint/failure rates). */
const SCALE = {
  growthA: 0.11, // confirmed between #1 and #2
  growthB: 0.09, // confirmed between #2 and #3
  churn: 0.06, // total unsubscribes, split across three post-issue waves
  pending: 0.03, // still-unconfirmed tail
  bounceRate: 0.004, // hard bounces (drawn from the core) → suppressions
  complaintRate: 0.001, // spam complaints (drawn from the core) → suppressions
  failureRate: 0.006, // per-send transport failures — do NOT suppress
};

/** Draw up to `count` distinct integers in [0, n) from the PRNG (fewer only if n < count).
 *  The guard bounds the loop when collisions crowd a small range. */
function drawDistinct(rand: () => number, count: number, n: number): number[] {
  const out = new Set<number>();
  const want = Math.min(count, n);
  let guard = want * 20 + 50;
  while (out.size < want && guard-- > 0) {
    out.add(Math.floor(rand() * n));
  }
  return [...out];
}

/** Per-send transport failures as audience indices — about `failureRate` of the frozen
 *  audience, at least one, PRNG-placed so the failures fall on different rows each send. */
function drawFailedSlots(rand: () => number, audienceLen: number): Set<number> {
  if (audienceLen === 0) {
    return new Set();
  }
  // Jitter the count (±30%) so each send's failure tally is organic, not a fixed fraction.
  const count = Math.max(1, Math.round(audienceLen * SCALE.failureRate * (0.7 + rand() * 0.6)));
  return new Set(drawDistinct(rand, count, audienceLen));
}

/**
 * The scaled counterpart to `buildAudience`: the same lifecycle (imported core, two growth
 * cohorts, three churn waves, a pending tail, and bounce/complaint suppressions) sized to
 * an approximate confirmed-now `size` and driven by the seeded PRNG, so `(size, seed)` is
 * reproducible while churn timing, suppression victims, and growth spread vary believably
 * instead of sitting on fixed indices. Addresses come from `scaledEmailFor`, collision-free
 * past the 3,600-address bijection.
 */
export function buildScaledAudience(t: Timeline, size: number, rand: () => number): BuiltAudience {
  // Jitter the target and each cohort with the PRNG so the counts read like a real list —
  // 1283, not exactly 1000 — instead of landing on round, synthetic-looking numbers. The
  // jitter is part of the seeded stream, so a given (size, seed) still reproduces exactly.
  const jitter = (spread: number): number => 1 - spread + rand() * 2 * spread;
  const n = Math.max(1, Math.round(size * jitter(0.12)));
  const growthA = Math.round(n * SCALE.growthA * jitter(0.15));
  const growthB = Math.round(n * SCALE.growthB * jitter(0.15));
  const core = Math.max(1, n - growthA - growthB); // the never-leaving backbone
  const churnTotal = Math.max(3, Math.round(n * SCALE.churn * jitter(0.2)));
  const pending = Math.max(1, Math.round(n * SCALE.pending * jitter(0.25)));

  let seq = 0;
  const subscribers: SeedSubscriber[] = [];
  const make = (
    status: SeedSubscriber["status"],
    createdAt: number,
    confirmedAt: number | null,
    unsubscribedAt: number | null,
  ): string => {
    const email = scaledEmailFor(seq++);
    subscribers.push({
      id: newId(),
      email,
      status,
      confirm_token: newToken(),
      unsub_token: newToken(),
      created_at: createdAt,
      confirmed_at: confirmedAt,
      unsubscribed_at: unsubscribedAt,
    });
    return email;
  };

  // A churn member leaves at a PRNG-dispersed moment after its issue but before the next
  // send, front-loaded (r² pushes most leaves soon after the issue) — so it's still mailed
  // by the issue it followed, and the frozen per-send audiences stay clean.
  const churnAt = (sentAt: number, nextAt: number): number => {
    const window = Math.max(HOUR, nextAt - sentAt - 12 * HOUR);
    const r = rand();
    return Math.round(sentAt + 6 * HOUR + r * r * window);
  };

  // Import: the core that stays, then three waves that each churn out after an issue
  // (wave 0 after #1, 1 after #2, 2 after #3) — imported already-confirmed, like a real
  // bulk migration, and dispersed over the ~10 days before send #1.
  const importCount = core + churnTotal;
  const importStep = (10 * DAY) / importCount;
  const churnWave1 = Math.round(churnTotal * 0.4); // leaves after #1
  const churnWave2 = Math.round(churnTotal * 0.33); // leaves after #2
  const churnWave3 = churnTotal - churnWave1 - churnWave2; // leaves after #3 (still gone today)
  const coreEmails: string[] = [];
  let importIdx = 0;
  const addImport = (count: number, wave: 0 | 1 | 2 | null) => {
    for (let i = 0; i < count; i++) {
      const createdAt = Math.round(t.importAt + importIdx * importStep);
      let unsubAt: number | null = null;
      let status: SeedSubscriber["status"] = "confirmed";
      if (wave != null) {
        const sentAt = unwrap(t.sentAt[wave], "send timeline slot");
        const nextAt = wave < 2 ? unwrap(t.sentAt[wave + 1], "send timeline slot") : t.now;
        unsubAt = churnAt(sentAt, nextAt);
        status = "unsubscribed";
      }
      const email = make(status, createdAt, createdAt, unsubAt);
      if (wave == null) {
        coreEmails.push(email);
      }
      importIdx++;
    }
  };
  addImport(core, null);
  addImport(churnWave1, 0);
  addImport(churnWave2, 1);
  addImport(churnWave3, 2);

  // Growth cohort A: confirmed between #1 and #2 (mailed by #2 and #3, not #1).
  for (let i = 0; i < growthA; i++) {
    const confirmedAt = Math.round(t.growthAAt + (i * (2 * DAY)) / Math.max(1, growthA));
    make("confirmed", confirmedAt - DAY, confirmedAt, null);
  }
  // Growth cohort B: confirmed between #2 and #3 (mailed by #3 only).
  for (let i = 0; i < growthB; i++) {
    const confirmedAt = Math.round(t.growthBAt + (i * (2 * DAY)) / Math.max(1, growthB));
    make("confirmed", confirmedAt - DAY, confirmedAt, null);
  }
  // Still pending: subscribed in the last few days, not yet confirmed — in no audience.
  for (let i = 0; i < pending; i++) {
    make("pending", t.now - ((i % 6) + 1) * DAY, null, null);
  }

  // Suppressions: a hard bounce and a spam complaint cohort, both drawn from the core (so
  // they were mailed by #1 and #2, then shadowed out of #3 and today). Disjoint draws, so
  // no address is both bounced and complained.
  const bounceCount = Math.max(1, Math.round(n * SCALE.bounceRate * jitter(0.3)));
  const complaintCount = Math.max(1, Math.round(n * SCALE.complaintRate * jitter(0.3)));
  const victims = drawDistinct(rand, bounceCount + complaintCount, coreEmails.length);
  const suppressions: SeedSuppression[] = [];
  const sendTwoEvents = new Map<string, DeliveryEvent>();
  victims.slice(0, bounceCount).forEach((idx) => {
    const email = unwrap(coreEmails[idx], "core subscriber");
    suppressions.push({
      email,
      reason: "bounce",
      detail: "550 5.1.1 user unknown",
      created_at: t.bounceAt,
    });
    sendTwoEvents.set(email, {
      event: "bounced",
      detail: "Recipient address rejected (550 5.1.1)",
      at: t.bounceAt,
    });
  });
  victims.slice(bounceCount).forEach((idx) => {
    const email = unwrap(coreEmails[idx], "core subscriber");
    suppressions.push({
      email,
      reason: "complaint",
      detail: "abuse report via feedback loop",
      created_at: t.complaintAt,
    });
    sendTwoEvents.set(email, { event: "complained", detail: "abuse", at: t.complaintAt });
  });

  const sentAudiences = t.sentAt.map((at) => mailableAt(subscribers, suppressions, at)) as [
    string[],
    string[],
    string[],
  ];
  return { subscribers, suppressions, sentAudiences, sendTwoEvents };
}

/**
 * Parse a seed-size token — `100`, `1k`, `10k`, `100k`, or a raw integer — into a count,
 * capped at 100k. Returns undefined for an absent or unparseable value, which selects the
 * curated (unscaled) demo dataset.
 */
export function parseSeedSize(raw: string | null | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const m = /^\s*(\d+)\s*(k)?\s*$/i.exec(raw);
  if (!m) {
    return undefined;
  }
  let value = Number.parseInt(m[1] ?? "", 10);
  if (m[2]) {
    value *= 1000;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(value, 100_000);
}

// --- deliveries -------------------------------------------------------------

/** A post-send provider event applied to one recipient's delivery row. */
interface DeliveryEvent {
  event: string;
  detail: string;
  at: number;
}

/**
 * Synthesize the per-recipient delivery record for one completed send. The audience is
 * the list frozen at send time, so the row count and `recipient_count` are that moment's
 * numbers, not today's. Most recipients are accepted and later marked delivered; the
 * recipients at `failedSlots` (audience indices the caller picks — fixed for the curated
 * demo, drawn from the seeded PRNG for a scaled list) fail at the transport level (a
 * send-loop failure, which does NOT itself suppress — only the webhook events below do);
 * and the addresses in `events` carry the bounce/complaint that produced this send's
 * suppressions.
 */
function buildDeliveries(
  sendId: string,
  audience: string[],
  sentAt: number,
  events: Map<string, DeliveryEvent>,
  failedSlots: Set<number>,
): SeedDelivery[] {
  return audience.map((email, i): SeedDelivery => {
    const base: SeedDelivery = {
      id: newId(),
      send_id: sendId,
      email,
      status: "accepted",
      provider_id: `fake-seed-${sendId}-${i}`,
      error: null,
      attempts: 1,
      updated_at: sentAt + 60 * 1000,
      event: "delivered",
      event_detail: null,
      event_at: sentAt + 2 * HOUR,
    };
    const ev = events.get(email);
    if (ev) {
      // Accepted by the provider, then bounced/complained via a later webhook.
      return { ...base, event: ev.event, event_detail: ev.detail, event_at: ev.at };
    }
    if (failedSlots.has(i)) {
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
  logoWritten: boolean;
  urls: { archive: string[]; admin: string };
}

/**
 * Reset the database and load the Windbreak demo dataset. `kestrelFile` and
 * `logoFile`, when provided, are written to R2 (the issue cover, and the publication
 * logo) — both are supplied by `scripts/seed.mjs` from `scripts/seed-assets/`, so
 * the seed carries no bundled bytes. The cover is referenced by the issue either
 * way (dropping the file in and re-seeding fills it), so it 404s until present; the
 * logo just falls back to the initial-letter tile when absent.
 */
export async function seedDatabase(
  env: AppEnv,
  config: Config,
  kestrelFile?: { bytes: ArrayBuffer; contentType: string; filename: string },
  logoFile?: { bytes: ArrayBuffer; contentType: string },
  options?: SeedOptions,
): Promise<SeedSummary> {
  const db = env.DB;
  const now = Date.now();
  const timeline = buildTimeline(now);

  await resetAll(db);

  // Give the demo a real identity so the reader surface, subscribe form, and issue
  // pages are branded out of the box as the mock publication, "Windbreak". The default
  // test recipients are the publisher's own proofing inboxes (they bypass the
  // subscribe/consent flow, §7), so "Send test email" pre-fills them out of the box and
  // that path is exercised without hand-typing an address. `.example` is the reserved
  // demo TLD, so these can never reach a real inbox even under a live provider.
  await updateSettings(db, {
    publication: {
      name: "Windbreak",
      tagline: "for the birds",
      address: "123 Beep Boop Lane, San Francisco, CA 94131",
    },
    testRecipients: ["editor@windbreak.example", "proof@windbreak.example"],
  });

  // And a real logo when one was supplied, so the brand tile isn't just the initial.
  // The bytes go to R2 under the reserved branding key; the metadata (with a
  // cache-busting version) goes to settings — the same two-step the upload route does.
  let logoWritten = false;
  if (logoFile) {
    await env.MEDIA.put(BRANDING_LOGO_KEY, logoFile.bytes, {
      httpMetadata: { contentType: logoFile.contentType },
    });
    await setPublicationLogo(db, { version: now, contentType: logoFile.contentType });
    logoWritten = true;
  }

  // Audience first, so recipient counts and deliveries are grounded in real rows. The
  // suppressions go in before we read the current audience, so it's confirmed − suppressed.
  //
  // A `size` selects the parametric, PRNG-driven audience (100 / 1k / 10k / 100k — an
  // approximate target for the confirmed-now list); without it the curated, story-shaped
  // list is unchanged. One PRNG instance threads through the audience build and the
  // per-send transport-failure draws, so a given (size, seed) reproduces the same dataset.
  const size = options?.size;
  const rand = makePrng(options?.seed ?? DEFAULT_SEED);
  const built = size != null ? buildScaledAudience(timeline, size, rand) : buildAudience(timeline);
  await insertSubscribers(db, built.subscribers);
  await insertSuppressions(db, built.suppressions);

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

  // Freeze each demo send through the same render path the app uses, with the demo
  // publication's branding (identity + default template) resolved above.
  const branding = resolveBranding(await getSettings(db), config);

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
      const { post, revision } = renderInputFor(issue, at, markdown);
      const result = await render({ post, revision, images }, config, branding);
      await insertPost(db, post, revision);
      await insertSend(db, {
        id: newId(),
        post_id: issue.id,
        status: "scheduled",
        fire_at: timeline.scheduledFireAt,
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

    // sent — its send time and frozen audience come from its timeline slot, so the
    // recipient count and delivery rows reflect the list AS IT WAS then (not today).
    const sentIndex = issue.sentIndex ?? 0;
    const completedAt = unwrap(timeline.sentAt[sentIndex], "send timeline slot");
    const sentAudience = unwrap(built.sentAudiences[sentIndex], "frozen send audience");
    const fireAt = completedAt - 30 * 1000; // fired, then completed half a minute later
    const scheduledAt = fireAt - DAY; // scheduled a day ahead of the send
    const { post, revision } = renderInputFor(issue, completedAt, markdown);
    const result = await render({ post, revision, images }, config, branding);
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
      recipient_count: sentAudience.length,
      scheduled_at: scheduledAt,
      started_at: fireAt,
      completed_at: completedAt,
    });
    // The bounce and the complaint were reported just after issue #2, so their events
    // (and the suppressions they produced) belong to that send alone.
    const events: Map<string, DeliveryEvent> = sentIndex === 1 ? built.sendTwoEvents : new Map();
    // Transport failures: the curated list's two fixed slots, or a PRNG-drawn set scaled
    // to the frozen audience when a size was requested.
    const failedSlots =
      size != null ? drawFailedSlots(rand, sentAudience.length) : new Set<number>([7, 53]);
    const deliveries = buildDeliveries(sendId, sentAudience, completedAt, events, failedSlots);
    await insertDeliveries(db, deliveries);
    counts.sent++;
    counts.deliveries += deliveries.length;
    archiveUrls.push(`${config.archiveOrigin}${config.archiveBasePath}/${issue.slug}`);
  }

  const bucket = (status: SeedSubscriber["status"]) =>
    built.subscribers.filter((s) => s.status === status).length;

  return {
    reset: true,
    subscribers: {
      confirmed: bucket("confirmed"),
      pending: bucket("pending"),
      unsubscribed: bucket("unsubscribed"),
    },
    suppressions: built.suppressions.length,
    audience: audience.length,
    posts: { sent: counts.sent, scheduled: counts.scheduled, draft: counts.draft },
    deliveries: counts.deliveries,
    coverImageBytesWritten,
    logoWritten,
    urls: { archive: archiveUrls, admin: `${config.appOrigin}/dashboard/` },
  };
}
