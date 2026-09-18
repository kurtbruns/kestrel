/**
 * The local demo dataset: a nature/birdwatching newsletter, "Windbreak", seeded
 * as a publication that has been running for a few months — not a thin static snapshot.
 *
 * It models a chronological lifecycle so the app's states are actually exercised:
 * an initial import of already-confirmed subscribers backdated before the first post,
 * three completed sends spread over time, and — in between — new confirmations (the
 * list grows) and unsubscribes (the list churns), plus a hard bounce and a spam
 * complaint that become suppressions. The upshot is that every completed send freezes
 * the audience AS IT WAS at that moment: someone who unsubscribes after post #2 is
 * still recorded as mailed by posts #1–#2, and a later suppression shadows the current
 * audience (confirmed − suppressed = mailable, I1) without rewriting any past send.
 *
 * Two rules it must not break:
 *  - A sent post's archived HTML is exactly what a real send would produce (I3/I5),
 *    so every post's frozen bytes come from the SAME `render()` the app uses — never
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
import { recomputeSendCounters } from "../db/sends";
import { BRANDING_LOGO_KEY, getSettings, setPublicationLogo, updateSettings } from "../db/settings";
import { audienceEmails } from "../db/subscribers";
import type { AppEnv, Config } from "../env";
import { newId, newToken } from "../lib/ids";
import { probeImageDimensions } from "../lib/image_dims";
import { DEFAULT_SEED, makePrng } from "../lib/prng";
import { unwrap } from "../lib/unwrap";
import { render } from "../render/render";
import { resolveBranding } from "../render/template_engine";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const HOUR = 60 * 60 * 1000;

/** The kestrel post's post id is fixed so the cover image's storage key is stable
 *  across re-seeds. The cover filename follows whatever file is supplied (jpg, webp,
 *  png, …); when none is, it falls back to this default and the reference 404s until
 *  a file is dropped in. */
const KESTREL_POST_ID = "5eed0001-0000-4000-8000-000000000001";
const DEFAULT_COVER_FILENAME = "kestrel.jpg";

type SeedPostKind = "sent" | "scheduled" | "draft";

interface SeedPost {
  id: string;
  slug: string;
  subject: string;
  markdown: string;
  kind: SeedPostKind;
  /** Sent posts only: which completed send on the timeline this is (0 = oldest).
   *  The send time and the frozen audience both come from that timeline slot. */
  sentIndex?: number;
  /** Draft posts only: how long ago the draft was last touched. */
  daysAgo?: number;
  hasCover?: boolean;
}

// --- the posts --------------------------------------------------------------

const SEED_POSTS: SeedPost[] = [
  {
    id: "5eed0004-0000-4000-8000-000000000004",
    slug: "welcome-to-windbreak",
    subject: "Welcome to Windbreak",
    kind: "sent",
    sentIndex: 0, // the launch post — the oldest in the archive
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
 *  re-seed keeps the same shape and the scheduled post always fires in the future.
 *
 *  Read as a story from the top: the list is imported, post #1 goes out, the list
 *  grows and sheds a few readers, post #2 goes out (and draws a bounce and a
 *  complaint just after), it grows again, then post #3 goes out. */
interface Timeline {
  now: number;
  importAt: number;
  bounceAt: number; // hard bounce reported just after #2
  complaintAt: number; // spam complaint reported just after #2
  scheduledFireAt: number;
  /** The three completed sends, oldest first — indexed by `SeedPost.sentIndex`. Each also
   *  anchors the churn wave it prompts and bounds the growth cohort confirmed after it: the
   *  gaps between these are where sign-ups and unsubscribes are dispersed. */
  sentAt: [number, number, number];
}

export function buildTimeline(now: number): Timeline {
  const send2At = now - 7 * WEEK;
  return {
    now,
    importAt: now - 14 * WEEK,
    bounceAt: send2At + DAY,
    complaintAt: send2At + 2 * DAY,
    scheduledFireAt: now + 2 * DAY,
    sentAt: [now - 12 * WEEK, send2At, now - 3 * WEEK],
  };
}

/** When a reader in a churn wave unsubscribes: a spike just after the post that
 *  prompted them, tapering off over the following days. The quadratic step front-loads
 *  the wave (member 0 leaves within hours, later members trickle out over ~1–2 weeks)
 *  while keeping every offset inside the gap before the next send — so the wave stays
 *  attributed to the post it followed and the frozen per-send audiences don't shift. */
function unsubscribedAfter(sentAt: number, indexInWave: number): number {
  return sentAt + 6 * HOUR + indexInWave * indexInWave * 8 * HOUR;
}

// --- audience ---------------------------------------------------------------

// The address pools, drawn from three wells so a scaled list reads as a roster of distinct
// people rather than a short sequence repeated with a counter: human GIVEN_NAMES, and
// SURNAMES built from bird species and the words of a bird's world (talon, hedgerow,
// thicket, …). The two pools are DISJOINT — no word appears in both — which is exactly what
// lets the local-part formats below never collide with one another (see `scaledEmailFor`).
const GIVEN_NAMES = [
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
  "arlo",
  "maya",
  "nils",
  "dahlia",
  "pearl",
  "edwin",
  "greta",
  "milo",
  "saoirse",
  "jonah",
  "esme",
  "tariq",
  "linnea",
  "cole",
  "freya",
  "amos",
  "ivy",
  "reuben",
  "marisol",
  "dev",
  "opal",
  "silas",
  "thea",
  "aziz",
  "colette",
  "hank",
  "magda",
  "quinn",
  "roscoe",
  "lucia",
  "omar",
  "delia",
  "pascal",
  "nina",
];
const SURNAMES = [
  "finch",
  "swift",
  "merlin",
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
  "wagtail",
  "goldfinch",
  "greenfinch",
  "bullfinch",
  "nightjar",
  "kittiwake",
  "godwit",
  "dunlin",
  "sanderling",
  "turnstone",
  "redstart",
  "stonechat",
  "whinchat",
  "chiffchaff",
  "blackcap",
  "firecrest",
  "goldcrest",
  "treecreeper",
  "nuthatch",
  "dipper",
  "shrike",
  "harrier",
  "buzzard",
  "goshawk",
  "hobby",
  "osprey",
  "bittern",
  "avocet",
  "lapwing",
  "woodcock",
  "nightingale",
  "blackbird",
  "skylark",
  "crossbill",
  "hawfinch",
  "chough",
  "raven",
  "magpie",
  "jackdaw",
  "talon",
  "hedgerow",
  "thicket",
  "reed",
  "marsh",
  "quill",
  "feather",
  "plume",
  "roost",
  "bramble",
  "heather",
  "gorse",
  "sedge",
  "meadow",
  "copse",
  "spinney",
  "covert",
  "warren",
  "furrow",
  "estuary",
];

// Reserved, un-deliverable domains only: `example.{com,net,org}` (RFC 2606) and labels under
// the reserved `.example` TLD (RFC 6761). Even under a live provider these can never reach a
// real inbox — the same guarantee `.example` gives the test recipients.
const DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
  "mail.example",
  "post.example",
  "inbox.example",
];

// Realistic local-part shapes. Each keeps BOTH whole name tokens around a single separator,
// so within a format the (given, surname) pair is recoverable; and because the two pools are
// disjoint, no two formats can ever render the same string (`ada.finch` vs `finch.ada` would
// need a word living in both pools). That disjointness is what makes `scaledEmailFor` a
// clean bijection across formats.
const LOCAL_FORMATS: ((given: string, surname: string) => string)[] = [
  (given, surname) => `${given}.${surname}`,
  (given, surname) => `${surname}.${given}`,
  (given, surname) => `${given}_${surname}`,
  (given, surname) => `${surname}_${given}`,
];

// The address space is every (name-pair × format × domain) combination — far larger than the
// 100k seed cap, so a scaled list never has to reuse a combination or fall back to a numeric
// suffix (the "loop and repeat" a small pool forces).
const NAME_PAIRS = GIVEN_NAMES.length * SURNAMES.length;
const ADDRESS_SPACE = NAME_PAIRS * LOCAL_FORMATS.length * DOMAINS.length;

// A full-period linear-congruential permutation of [0, ADDRESS_SPACE): `n ↦ (MULT·n + INC)
// mod ADDRESS_SPACE` is a bijection because MULT is coprime to ADDRESS_SPACE. It scatters
// consecutive indices to far-apart points, so successive subscribers differ in name AND
// format AND domain — no run shares a surname, a format, or a domain. MULT is the golden-ratio
// odd constant (coprime to ADDRESS_SPACE = 2¹²·3·11); INC only shifts where the cycle starts.
const SCRAMBLE_MULT = 0x9e3779b1;
const SCRAMBLE_INC = 1013904223;

/**
 * A deterministic, collision-free, human-plausible address for ANY global index `n`. The
 * index is permuted across the whole (name-pair × format × domain) space and decoded into a
 * given name, a surname, a local-part format, and a domain — so every address is unique and,
 * up to the 100k seed cap, none carries a numeric suffix. (An `n` past the space — unreachable
 * at any supported size — wraps with a trailing cycle number as a last-resort safety net.)
 */
export function scaledEmailFor(n: number): string {
  const cycle = Math.floor(n / ADDRESS_SPACE);
  const s = (SCRAMBLE_MULT * (n % ADDRESS_SPACE) + SCRAMBLE_INC) % ADDRESS_SPACE;
  const formatIdx = s % LOCAL_FORMATS.length;
  const domainIdx = Math.floor(s / LOCAL_FORMATS.length) % DOMAINS.length;
  const pairIdx = Math.floor(s / (LOCAL_FORMATS.length * DOMAINS.length));
  const given = unwrap(GIVEN_NAMES[pairIdx % GIVEN_NAMES.length], "given name");
  const surname = unwrap(SURNAMES[Math.floor(pairIdx / GIVEN_NAMES.length)], "surname");
  const format = unwrap(LOCAL_FORMATS[formatIdx], "local-part format");
  const domain = unwrap(DOMAINS[domainIdx], "email domain");
  const local = cycle === 0 ? format(given, surname) : `${format(given, surname)}${cycle + 1}`;
  return `${local}@${domain}`;
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
 * Build the whole audience as a lifecycle: an imported core, a continuous stream of later
 * confirmations (the list keeps growing to today), three churn waves that each unsubscribe in
 * the days after a post lands, a few still-pending sign-ups biased toward the recent past,
 * and two suppressions (a bounce and a complaint) drawn from the core so they visibly shadow
 * the current audience. The counts are chosen so the mailable audience genuinely fluctuates
 * from send to send (140 → 147 → 151) and settles at 155 today (157 confirmed − 2 suppressed).
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
    const email = scaledEmailFor(seq++);
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

  // Initial import: already-confirmed addresses migrated in before post #1 (a real list
  // starts as a bulk import, not one opt-in at a time). Three waves of them later churn out
  // — each wave leaving in the days after the last post it received, so its members are
  // still mailed by that post but not the next; the rest are the core that stays.
  //
  // The churners are scattered THROUGH the import window, not appended after the core, so a
  // subscriber's signup date carries no hint of whether they later leave — the roster reads
  // as mixed statuses over time, not a block of confirmations followed by a block of
  // unsubscribes. The wave tags are interleaved (round-robin) across those scattered slots
  // too, so "left after #1" and "left after #3" both span the whole window.
  const IMPORT = 140;
  const importStep = (10 * DAY) / IMPORT; // spread across ~10 days, all before send #1
  const churnWaves = [
    { sentAt: t.sentAt[0], count: 6 }, // wave after #1 — leaves before #2
    { sentAt: t.sentAt[1], count: 5 }, // wave after #2 — leaves before #3
    { sentAt: t.sentAt[2], count: 4 }, // wave after #3 — still gone today
  ];
  // One entry per churner, waves interleaved round by round; `inWave` (the round) feeds the
  // front-loaded unsub spike so early members leave sooner than later ones.
  const churnEntries: { sentAt: number; inWave: number }[] = [];
  const maxWave = Math.max(...churnWaves.map((w) => w.count));
  for (let round = 0; round < maxWave; round++) {
    for (const w of churnWaves) {
      if (round < w.count) {
        churnEntries.push({ sentAt: w.sentAt, inWave: round });
      }
    }
  }
  // Place the churners at evenly spaced slots across the whole import cohort.
  const churnBySlot = new Map<number, { sentAt: number; inWave: number }>();
  churnEntries.forEach((entry, j) => {
    churnBySlot.set(Math.round(((j + 0.5) * IMPORT) / churnEntries.length), entry);
  });
  const coreEmails: string[] = [];
  for (let slot = 0; slot < IMPORT; slot++) {
    const createdAt = Math.round(t.importAt + slot * importStep); // imported already confirmed
    const churn = churnBySlot.get(slot);
    if (churn) {
      make("unsubscribed", createdAt, createdAt, unsubscribedAfter(churn.sentAt, churn.inWave));
    } else {
      coreEmails.push(make("confirmed", createdAt, createdAt, null));
    }
  }

  // Organic growth: confirmed sign-ups arriving in one continuous stream from just after the
  // first post right up to today — the list is still growing, it doesn't stop at the last
  // historical send. Each confirms shortly after signing up (double opt-in is near-instant for
  // most), and the stream spans all three sends, so every completed send freezes a different,
  // growing slice while the newest confirmations sit near "now".
  const GROWTH = 32;
  const growthStart = unwrap(t.sentAt[0], "send timeline slot") + 3 * DAY;
  const growthSpan = t.now - growthStart;
  for (let i = 0; i < GROWTH; i++) {
    const signupAt = Math.round(growthStart + ((i + 0.5) * growthSpan) / GROWTH);
    const confirmLatency = Math.round((0.3 + (i % 5) * 0.4) * HOUR); // ~20 min to ~2 h
    make("confirmed", signupAt, signupAt + confirmLatency, null);
  }
  // Still pending: signed up but never clicked confirm — in no audience. Confirmation is
  // near-instant for almost everyone, so a still-pending row is either a sign-up from the last
  // few hours (not clicked YET) or a rare abandon; the likelihood drops off fast with age (a
  // month-old pending is unusual). A cubic recency bias packs most into the last day or two,
  // with a thin tail reaching back a couple of weeks. (`confirmed_at` null → no audience effect.)
  const PENDING = 3;
  for (let i = 0; i < PENDING; i++) {
    const u = (i + 0.5) / PENDING;
    make("pending", Math.round(t.now - u * u * u * (14 * DAY)), null, null);
  }

  // Two core subscribers draw a hard bounce and a spam complaint just after post #2.
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
  // The bounce and complaint were reported just after post #2, so their delivery events
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

// The seeded PRNG lives in lib/prng.ts (shared with the dev send simulation); re-export
// it here so `--size`/`--seed` reproducibility and its tests keep their existing import.
export { DEFAULT_SEED, makePrng };

/** Cohort proportions and low outcome rates for a scaled list, expressed as fractions of
 *  the approximate confirmed-now `size`. Chosen so the scaled dataset keeps the curated
 *  list's story shape — an imported core, two growth cohorts, a churn wave after each
 *  post, a small pending tail, and a few suppressions — with realistic percentages at
 *  every size (low bounce/complaint/failure rates). */
const SCALE = {
  growthA: 0.11, // confirmed between #1 and #2
  growthB: 0.09, // confirmed between #2 and #3
  churn: 0.06, // total unsubscribes, split across three waves, one after each post
  pending: 0.012, // small still-unconfirmed backlog — most sign-ups confirm
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
 *  audience, at least one, PRNG-placed so the unsent rows fall on different rows each send. */
function drawUnsentSlots(rand: () => number, audienceLen: number): Set<number> {
  if (audienceLen === 0) {
    return new Set();
  }
  // Jitter the count (±30%) so each send's failure tally is organic, not a fixed fraction.
  const count = Math.max(1, Math.round(audienceLen * SCALE.failureRate * (0.7 + rand() * 0.6)));
  return new Set(drawDistinct(rand, count, audienceLen));
}

/**
 * The scaled counterpart to `buildAudience`: the same lifecycle (imported core, a rolling
 * confirmed-growth stream to today, three churn waves, a recency-biased pending tail, and
 * bounce/complaint suppressions) sized to an approximate confirmed-now `size` and driven by
 * the seeded PRNG, so `(size, seed)` is
 * reproducible while churn timing, suppression victims, and growth spread vary believably
 * instead of sitting on fixed indices. Addresses come from `scaledEmailFor`, collision-free
 * to the 100k cap and beyond.
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

  // A churn member leaves at a PRNG-dispersed moment after its post but before the next
  // send, front-loaded (r² pushes most leaves soon after the post) — so it's still mailed
  // by the post it followed, and the frozen per-send audiences stay clean.
  const churnAt = (sentAt: number, nextAt: number): number => {
    const window = Math.max(HOUR, nextAt - sentAt - 12 * HOUR);
    const r = rand();
    return Math.round(sentAt + 6 * HOUR + r * r * window);
  };

  // Import: a core that stays plus three churn waves that each leave after a post (wave 0
  // after #1, 1 after #2, 2 after #3) — imported already-confirmed, like a real bulk
  // migration, and dispersed over the ~10 days before send #1. The churners are drawn at
  // RANDOM positions across the whole cohort (not appended after the core), so a subscriber's
  // signup date is uncorrelated with whether they later leave; the wave tags land on those
  // positions in the PRNG's own draw order, so no wave clusters at one end of the window.
  const importCount = core + churnTotal;
  const importStep = (10 * DAY) / importCount;
  const churnWave1 = Math.round(churnTotal * 0.4); // leaves after #1
  const churnWave2 = Math.round(churnTotal * 0.33); // leaves after #2
  const churnWave3 = churnTotal - churnWave1 - churnWave2; // leaves after #3 (still gone today)
  const waveTags: (0 | 1 | 2)[] = [
    ...Array<0 | 1 | 2>(churnWave1).fill(0),
    ...Array<0 | 1 | 2>(churnWave2).fill(1),
    ...Array<0 | 1 | 2>(churnWave3).fill(2),
  ];
  const waveBySlot = new Map<number, 0 | 1 | 2>();
  drawDistinct(rand, churnTotal, importCount).forEach((slot, j) => {
    waveBySlot.set(slot, unwrap(waveTags[j], "churn wave tag"));
  });
  const coreEmails: string[] = [];
  for (let slot = 0; slot < importCount; slot++) {
    const createdAt = Math.round(t.importAt + slot * importStep);
    const wave = waveBySlot.get(slot);
    if (wave != null) {
      const sentAt = unwrap(t.sentAt[wave], "send timeline slot");
      const nextAt = wave < 2 ? unwrap(t.sentAt[wave + 1], "send timeline slot") : t.now;
      make("unsubscribed", createdAt, createdAt, churnAt(sentAt, nextAt));
    } else {
      coreEmails.push(make("confirmed", createdAt, createdAt, null));
    }
  }

  // Organic growth: one continuous stream of confirmed sign-ups from just after the first
  // post right up to today (the list is still growing, not frozen at the last historical
  // send), PRNG-dispersed so it reads as steady week-over-week growth. Each confirms shortly
  // after signing up. `growthA`/`growthB` only size the stream (and the core above); the two
  // are now one rolling cohort, so the newest confirmations sit near "now".
  const growthTotal = growthA + growthB;
  const growthStart = unwrap(t.sentAt[0], "send timeline slot") + 3 * DAY;
  const growthSpan = t.now - growthStart;
  for (let i = 0; i < growthTotal; i++) {
    const signupAt = Math.round(growthStart + rand() * growthSpan);
    const confirmLatency = Math.round((0.2 + rand() * 3) * HOUR); // near-instant confirm
    make("confirmed", signupAt, signupAt + confirmLatency, null);
  }
  // Still pending: signed up but never clicked confirm — in no audience. Confirmation is
  // near-instant for almost everyone, so a still-pending row is either a sign-up from the last
  // few hours (not clicked YET) or a rare abandon; the likelihood falls off fast with age. A
  // cubic recency bias packs most into the last day or two, with a thin tail back a couple of
  // weeks — no month-old block. (`confirmed_at` null → no audience effect.)
  for (let i = 0; i < pending; i++) {
    const u = rand();
    make("pending", Math.round(t.now - u * u * u * (14 * DAY)), null, null);
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
 * recipients at `unsentSlots` (audience indices the caller picks — fixed for the curated
 * demo, drawn from the seeded PRNG for a scaled list) are left unsent at the transport
 * level (a send-loop failure, which does NOT itself suppress — only the webhook events
 * below do); and the addresses in `events` carry the bounce/complaint that produced this
 * send's suppressions.
 */
function buildDeliveries(
  sendId: string,
  audience: string[],
  sentAt: number,
  events: Map<string, DeliveryEvent>,
  unsentSlots: Set<number>,
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
      // Accepted by the provider, then bounced/complained via a later webhook. The demo's
      // bounces are permanent (they draw the send's suppressions), so their frozen kind is
      // `hard`; a complaint carries no bounce kind.
      const bounce_kind = ev.event === "bounced" ? "hard" : null;
      return { ...base, event: ev.event, event_detail: ev.detail, event_at: ev.at, bounce_kind };
    }
    if (unsentSlots.has(i)) {
      return {
        ...base,
        status: "unsent",
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
  seedPost: SeedPost,
  at: number,
  markdown: string,
): { post: PostRow; revision: RevisionRow } {
  const post: PostRow = {
    id: seedPost.id,
    slug: seedPost.slug,
    subject: seedPost.subject,
    status:
      seedPost.kind === "draft" ? "draft" : seedPost.kind === "scheduled" ? "scheduled" : "sent",
    current_revision: `${seedPost.id}-rev`,
    created_at: at,
    updated_at: at,
  };
  const revision: RevisionRow = {
    id: `${seedPost.id}-rev`,
    post_id: seedPost.id,
    markdown,
    metadata: JSON.stringify({ subject: seedPost.subject, slug: seedPost.slug }),
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
 * `logoFile`, when provided, are written to R2 (the post cover, and the publication
 * logo) — both are supplied by `scripts/seed.mjs` from `scripts/seed-assets/`, so
 * the seed carries no bundled bytes. The cover is referenced by the post either
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

  // Give the demo a real identity so the reader surface, subscribe form, and post
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
  // the bytes if given, and record the row either way so the rendered post resolves
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

  for (const seedPost of SEED_POSTS) {
    const images = seedPost.hasCover ? coverImages : [];
    // Point the cover reference at the actual cover filename (e.g. kestrel.webp).
    const markdown = seedPost.hasCover
      ? seedPost.markdown.replace("kestrel.jpg", coverFilename)
      : seedPost.markdown;

    if (seedPost.kind === "draft") {
      const at = now - (seedPost.daysAgo ?? 2) * DAY;
      const { post, revision } = renderInputFor(seedPost, at, markdown);
      await insertPost(db, post, revision);
      counts.draft++;
      continue;
    }

    if (seedPost.kind === "scheduled") {
      const at = now;
      const { post, revision } = renderInputFor(seedPost, at, markdown);
      const result = await render({ post, revision, images }, config, branding);
      await insertPost(db, post, revision);
      await insertSend(db, {
        id: newId(),
        post_id: seedPost.id,
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
    const sentIndex = seedPost.sentIndex ?? 0;
    const completedAt = unwrap(timeline.sentAt[sentIndex], "send timeline slot");
    const sentAudience = unwrap(built.sentAudiences[sentIndex], "frozen send audience");
    const fireAt = completedAt - 30 * 1000; // fired, then completed half a minute later
    const scheduledAt = fireAt - DAY; // scheduled a day ahead of the send
    const { post, revision } = renderInputFor(seedPost, completedAt, markdown);
    const result = await render({ post, revision, images }, config, branding);
    await insertPost(db, post, revision);
    if (seedPost.hasCover) {
      await insertImage(db, coverRow);
    }
    const sendId = newId();
    await insertSend(db, {
      id: sendId,
      post_id: seedPost.id,
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
    // The bounce and the complaint were reported just after post #2, so their events
    // (and the suppressions they produced) belong to that send alone.
    const events: Map<string, DeliveryEvent> = sentIndex === 1 ? built.sendTwoEvents : new Map();
    // Transport failures: the curated list's two fixed slots, or a PRNG-drawn set scaled
    // to the frozen audience when a size was requested.
    const unsentSlots =
      size != null ? drawUnsentSlots(rand, sentAudience.length) : new Set<number>([7, 53]);
    const deliveries = buildDeliveries(sendId, sentAudience, completedAt, events, unsentSlots);
    await insertDeliveries(db, deliveries);
    // The seed writes delivery rows directly (fixture data the normal path never
    // produces), so bring the denormalized counters (migration 0006) in line with them.
    await recomputeSendCounters(db, sendId);
    counts.sent++;
    counts.deliveries += deliveries.length;
    archiveUrls.push(`${config.archiveOrigin}${config.archiveBasePath}/${seedPost.slug}`);
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
