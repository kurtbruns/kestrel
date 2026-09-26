/**
 * The local demo dataset: "Field Notes", a demo publication whose issues walk through what
 * Kestrel does, seeded as a publication that has been running for a few months — not a thin
 * static snapshot. Between them the posts use what the render path handles (a cover image,
 * headings, emphasis, both kinds of list, links).
 *
 * It models a chronological lifecycle so the app's states are actually exercised:
 * an initial import of already-confirmed subscribers backdated before the first post,
 * four completed sends spread over time, and — in between — new confirmations (the
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
import { onTheMinute } from "../send/schedule";
import { type DemoPost, loadDemo } from "./demo";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const HOUR = 60 * 60 * 1000;

/** An image file `scripts/seed.mjs` uploads from a post's bundle, named `<bundle>/<file>`. */
export interface DemoImageFile {
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
}

/** A demo post's id comes from its place in `demo/posts` (the first file is …0001), so a
 *  re-seed keeps each post's editor URL and the cover image's storage key the same. */
function demoPostId(position: number): string {
  return `5eed${String(position).padStart(4, "0")}-0000-4000-8000-${String(position).padStart(12, "0")}`;
}

// --- the timeline -----------------------------------------------------------

/** Absolute epoch-ms anchors for the seeded lifecycle, all relative to `now` so a
 *  re-seed keeps the same shape and the scheduled post always fires in the future.
 *
 *  Read as a story from the top: the list is imported, post #1 goes out, the list
 *  grows and sheds a few readers, post #2 goes out (and draws a bounce and a
 *  complaint just after), it grows again, then posts #3 and #4 go out. */
interface Timeline {
  now: number;
  importAt: number;
  bounceAt: number; // hard bounce reported just after #2
  complaintAt: number; // spam complaint reported just after #2
  scheduledFireAt: number;
  /** The four completed sends, oldest first — the demo's sent posts take them in order. The first
   *  three each anchor the churn wave they prompt, and all of them bound the growth cohort
   *  confirmed after them: the gaps between these are where sign-ups and unsubscribes are
   *  dispersed. */
  sentAt: number[];
}

export function buildTimeline(now: number): Timeline {
  // A weekly newsletter: four sends a week apart, the last five days ago, and the scheduled
  // issue two days out, a week after it. The list was imported just before the first.
  const first = now - 26 * DAY;
  const send2At = first + WEEK;
  return {
    now,
    importAt: first - 12 * DAY,
    bounceAt: send2At + DAY,
    complaintAt: send2At + 2 * DAY,
    scheduledFireAt: onTheMinute(now + 2 * DAY), // on the minute, as the API stores a fire time
    sentAt: [first, send2At, first + 2 * WEEK, first + 3 * WEEK],
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
  sentAudiences: string[][];
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
      // The confirmation went out when they signed up, so a pending link ages from then.
      confirm_sent_at: createdAt,
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
    { sentAt: unwrap(t.sentAt[0], "send timeline slot"), count: 6 }, // after #1, gone before #2
    { sentAt: unwrap(t.sentAt[1], "send timeline slot"), count: 5 }, // after #2, gone before #3
    { sentAt: unwrap(t.sentAt[2], "send timeline slot"), count: 4 }, // after #3, gone before #4
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
  // most), and the stream spans every send, so every completed send freezes a different,
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
  // from then on, so they were mailed by #1 and #2 yet shadowed out of #3, #4, and today.
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

  const sentAudiences = t.sentAt.map((at) => mailableAt(subscribers, suppressions, at));
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
 *  approximate target, not exact); absent, the curated Field Notes dataset is loaded
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
      // The confirmation went out when they signed up, so a pending link ages from then.
      confirm_sent_at: createdAt,
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
      const nextAt = t.sentAt[wave + 1] ?? t.now; // before the next send, or today after the last
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
  // they were mailed by #1 and #2, then shadowed out of #3, #4, and today). Disjoint draws, so
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

  const sentAudiences = t.sentAt.map((at) => mailableAt(subscribers, suppressions, at));
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
  id: string,
  demoPost: DemoPost,
  at: number,
  markdown: string,
): { post: PostRow; revision: RevisionRow } {
  const post: PostRow = {
    id,
    slug: demoPost.slug,
    subject: demoPost.subject,
    status: demoPost.status,
    current_revision: `${id}-rev`,
    created_at: at,
    updated_at: at,
  };
  const revision: RevisionRow = {
    id: `${id}-rev`,
    post_id: id,
    markdown,
    metadata: JSON.stringify({ subject: demoPost.subject, slug: demoPost.slug }),
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
  /** How many of the images the posts show had their bytes supplied and written to R2. */
  imagesWritten: number;
  logoWritten: boolean;
  urls: { archive: string[]; admin: string };
}

/**
 * Reset the database and load the demo publication: its identity and posts come from the
 * Markdown under `demo/` (see `loadDemo`), its subscribers and send history from the
 * timeline here. `imageFiles` and `logoFile`, when provided, are written to R2 (the images
 * the posts show, and the publication logo) — both are supplied by `scripts/seed.mjs` from
 * `demo/`, so the seed carries no bundled bytes. The cover is referenced by the post either
 * way (dropping the file in and re-seeding fills it), so it 404s until present; the
 * logo just falls back to the initial-letter tile when absent.
 */
export async function seedDatabase(
  env: AppEnv,
  config: Config,
  imageFiles: DemoImageFile[] = [],
  logoFile?: { bytes: ArrayBuffer; contentType: string },
  options?: SeedOptions,
): Promise<SeedSummary> {
  const db = env.DB;
  const now = Date.now();
  const timeline = buildTimeline(now);
  const demo = loadDemo();
  const sentPosts = demo.posts.filter((p) => p.status === "sent").length;
  if (sentPosts > timeline.sentAt.length) {
    throw new Error(
      `demo/posts has ${sentPosts} sent posts, but the seed timeline has ${timeline.sentAt.length} sends`,
    );
  }

  await resetAll(db);

  // Give the demo a real identity so the reader surface, subscribe form, and post
  // pages are branded out of the box as the demo publication (`demo/publication.md`). The default
  // test recipients are the publisher's own proofing inboxes (they bypass the
  // subscribe/consent flow, §7), so "Send test email" pre-fills them out of the box and
  // that path is exercised without hand-typing an address. `.example` is the reserved
  // demo TLD, so these can never reach a real inbox even under a live provider.
  await updateSettings(db, {
    publication: {
      name: demo.publication.name,
      tagline: demo.publication.tagline,
      address: demo.publication.address,
    },
    testRecipients: demo.publication.testRecipients,
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

  // Post images: each post's Markdown shows its images by filename, and each file sits beside
  // the post's `index.md` in its bundle. The row is recorded either way so the render
  // resolves the reference; the bytes land in R2 when `scripts/seed.mjs` supplied the file
  // (missing, that one image 404s until it's back).
  const uploaded = new Map(imageFiles.map((f) => [f.filename, f]));
  const imagesByPost = new Map<number, ImageRow[]>();
  let imageBytesWritten = 0;
  for (const [i, demoPost] of demo.posts.entries()) {
    for (const name of demoPost.images) {
      const position = i + 1;
      const file = uploaded.get(`${demoPost.bundle}/${name}`);
      const key = `posts/${demoPostId(position)}/${name}`;
      const dims = file ? probeImageDimensions(new Uint8Array(file.bytes)) : null;
      const row: ImageRow = {
        id: newId(),
        post_id: demoPostId(position),
        filename: name,
        storage_key: key,
        content_type: file?.contentType || "application/octet-stream",
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        created_at: now,
      };
      if (file) {
        await env.MEDIA.put(key, file.bytes, { httpMetadata: { contentType: row.content_type } });
        imageBytesWritten++;
      }
      imagesByPost.set(position, [...(imagesByPost.get(position) ?? []), row]);
    }
  }

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

  let sentIndex = 0;
  for (const [i, demoPost] of demo.posts.entries()) {
    const id = demoPostId(i + 1);
    const images = imagesByPost.get(i + 1) ?? [];
    const markdown = demoPost.markdown;
    const insertPostWithImages = async (post: PostRow, revision: RevisionRow) => {
      await insertPost(db, post, revision);
      for (const image of images) {
        await insertImage(db, image);
      }
    };

    if (demoPost.status === "draft") {
      const at = now - (demoPost.editedDaysAgo ?? 2) * DAY;
      const { post, revision } = renderInputFor(id, demoPost, at, markdown);
      await insertPostWithImages(post, revision);
      counts.draft++;
      continue;
    }

    if (demoPost.status === "scheduled") {
      const at = now;
      const { post, revision } = renderInputFor(id, demoPost, at, markdown);
      const result = await render({ post, revision, images }, config, branding);
      await insertPostWithImages(post, revision);
      await insertSend(db, {
        id: newId(),
        post_id: id,
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
    const completedAt = unwrap(timeline.sentAt[sentIndex], "send timeline slot");
    const sentAudience = unwrap(built.sentAudiences[sentIndex], "frozen send audience");
    const fireAt = onTheMinute(completedAt) - 60 * 1000; // fired on the minute, completed within it
    const scheduledAt = fireAt - DAY; // scheduled a day ahead of the send
    const { post, revision } = renderInputFor(id, demoPost, completedAt, markdown);
    const result = await render({ post, revision, images }, config, branding);
    await insertPostWithImages(post, revision);
    const sendId = newId();
    await insertSend(db, {
      id: sendId,
      post_id: id,
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
    // produces), so bring the denormalized counters (`sends.c_*`) in line with them.
    await recomputeSendCounters(db, sendId);
    counts.sent++;
    counts.deliveries += deliveries.length;
    archiveUrls.push(`${config.archiveOrigin}${config.archiveBasePath}/${demoPost.slug}`);
    sentIndex++;
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
    imagesWritten: imageBytesWritten,
    logoWritten,
    urls: { archive: archiveUrls, admin: `${config.appOrigin}/dashboard/` },
  };
}
