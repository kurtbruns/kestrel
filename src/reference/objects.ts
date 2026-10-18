/**
 * The objects the API reference describes once (SPEC §11): each resource a route returns, field
 * by field, with its enum values and an example, so a route says "returns the send view" and
 * adds only the fields of its own. The shared meanings (a condition's kinds, a subscriber's
 * statuses, a suppression's reasons) are read from the same constants the server and the
 * editor word them with, so the reference can't describe them differently.
 */

import { DAILY_WRITES_SEND_RECIPIENTS, FREE_PLAN_LIST } from "../../shared/free_plan";
import type { ImportPlanResponse } from "../../shared/imports";
import type { Post, RevisionResponse } from "../../shared/posts";
import type {
  ObjectKey,
  ReferenceField,
  ReferenceObject,
  ReferenceTable,
} from "../../shared/reference";
import {
  BOUNCE_SPIKE_MIN,
  BOUNCE_SPIKE_RATE,
  BOUNCE_SPIKE_RECENT_MS,
  type ConditionKind,
  type HaltCause,
  type HaltReason,
  NO_RECEIPTS_AFTER_MS,
  SELF_THROTTLE_HALTS,
  type SendCondition,
  type SendHalt,
  type SendView,
  STUCK_THRESHOLD_MS,
} from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import {
  ERASED_MARKER_MEANING,
  FLAG_MEANING,
  STATUS_MEANING,
  SUPPRESSED_MEANING,
  SUPPRESSION_FLAG,
  type SuppressionFlag,
} from "../../shared/subscriber_meanings";
import type {
  SubscriberListItem,
  SubscriberStatus,
  Suppression,
  SuppressionReason,
} from "../../shared/subscribers";
import { HALT_BACKOFF_MS, MISSED_THRESHOLD_MS } from "../lib/time";

/** A halt's retry schedule in words, read off `HALT_BACKOFF_MS` so the two can't drift:
 *  "after 1, 2, and 5 minutes and then every 15 minutes". */
export function retrySchedule(steps: readonly number[]): string {
  const minutes = steps.map((ms) => ms / 60_000);
  const last = minutes.pop();
  const head =
    minutes.length > 1
      ? `${minutes.slice(0, -1).join(", ")}, and ${minutes.at(-1)}`
      : `${minutes[0]}`;
  return `after ${head} minutes and then every ${last} minutes`;
}

/** A wire type with any field left out at any depth, for an example that shows only the fields
 *  that tell it (the settings' template and deploy reflection run long). Each field it does show
 *  is still checked against the type. */
type Abridged<T> = { [K in keyof T]?: T[K] extends object ? Abridged<T[K]> : T[K] };

const RECENT_DAYS = BOUNCE_SPIKE_RECENT_MS / 86_400_000;

/** One send, as every send route carries it. */
const SEND_EXAMPLE = {
  id: "s_xyz789",
  post_id: "p_abc123",
  subject: "Spring migration",
  status: "sending",
  email_only: false,
  web_link: "unlisted",
  rev: 57,
  as_of: 1768467610000,
  fire_at: 1768467600000,
  scheduled_at: 1768381200000,
  started_at: 1768467601000,
  completed_at: null,
  remade_at: null,
  tested_at: 1768390000000,
  audience: { count: 1200, fixed: true, fixed_at: 1768467601000 },
  counts: {
    pending: 700,
    in_flight: 40,
    accepted: 455,
    delivered: 0,
    bounced: 3,
    complained: 1,
    skipped: 1,
    unsent: 0,
  },
  dispatch: { done: 460, percent: 38, rate_per_min: 230, eta_ms: 185000 },
  delivery: { confirmed: 4, percent_of_accepted: 1 },
  provider: { name: "ses", halt: null },
  phase: "progressing",
  conditions: [],
  actions: [],
  next_change_at: 1768467610000,
  links: {
    self: "/api/sends/s_xyz789",
    email_html: "/api/sends/s_xyz789/email?format=html",
    email_text: "/api/sends/s_xyz789/email?format=text",
    deliveries: "/api/sends/s_xyz789/deliveries",
    deliveries_csv: "/api/sends/s_xyz789/deliveries.csv",
    post: "/api/posts/p_abc123",
    archive: null,
    unlisted: "https://newsletter.example.com/email/9f2c41d0-7ab35e8c-6d1f04b2-a7e9c350",
  },
} satisfies SendView;

/**
 * A send as a route's example shows it: the fields that tell its state, since the whole view
 * is described once under Objects. `over` sets what this route's answer changes.
 */
export function sendBrief(over: Partial<SendView> = {}): Partial<SendView> {
  return {
    id: SEND_EXAMPLE.id,
    subject: SEND_EXAMPLE.subject,
    status: SEND_EXAMPLE.status,
    phase: SEND_EXAMPLE.phase,
    rev: SEND_EXAMPLE.rev,
    fire_at: SEND_EXAMPLE.fire_at,
    conditions: [],
    actions: [],
    ...over,
  };
}

/** One condition kind as the reference's table gives it. */
interface ConditionKindDoc {
  /** Its severity, or both when it rises. */
  severity: string;
  /** The fields its kind carries beside the ones every condition has. */
  fields: string;
  /** What it means, in words to tell the publisher. */
  meaning: string;
  /** What settles it, and who acts. */
  remedy: string;
}

/**
 * Every condition kind, as the send view's table lists them. A Record over `ConditionKind`, so
 * a new condition fails to compile until it is described here; the severities and fields are
 * the ones `sendConditions` (src/send/conditions.ts) gives.
 */
const CONDITION_KINDS: Record<ConditionKind, ConditionKindDoc> = {
  missed: {
    severity: "`action`",
    fields: "",
    meaning: `Still scheduled ${MISSED_THRESHOLD_MS / 60_000} minutes past its fire time: the sweep that fires sends is not running.`,
    remedy:
      "Whoever runs the deployment checks the Worker's Cron Trigger (`triggers.crons`) and its logs; locally, `npm run dev` runs the sweep. The send goes out as soon as the sweep runs again; nothing in this API fires it.",
  },
  stuck: {
    severity: "`warn`",
    fields: "",
    meaning: `Sending, with no recipient handed off for ${STUCK_THRESHOLD_MS / 60_000} minutes and no halt or wedge to explain it: the sweep has stopped, every run on it fails, or another send is taking every tick. A send that keeps handing off, however slowly, is never stuck.`,
    remedy:
      "If another send is going out, this one picks up once it finishes. Otherwise whoever runs the deployment reads the logs and checks the Cron Trigger. It carries on from where it stopped, mailing no one twice.",
  },
  wedged: {
    severity: "`action`",
    fields: "`count`",
    meaning:
      "`count` recipients whose hand-off the provider never answered, so whether they were mailed is unknown, and the send can't finish until they are resolved.",
    remedy:
      "The publisher decides, through the condition's `action` (Resolve): `unsent`, the safe default (they may miss this post), or `accepted`, only when they know those readers got it.",
  },
  refused: {
    severity: "`action`",
    fields: "`cause`, `error`, `advice`, `retry_at`",
    meaning:
      "The provider refuses the account, or this send's own email (`cause` `content` or `invalid_request`); `error` is its words. No one is marked unsent.",
    remedy:
      "`advice` names the fix and who makes it, by `cause` (the halt object's causes); almost always outside this API. The send retries on its own at `retry_at` and resumes once the fix lands.",
  },
  provider_unavailable: {
    severity: `\`info\`, or \`warn\` after ${SELF_THROTTLE_HALTS} rate-limit halts in a row`,
    fields: "`error`, `retry_at`",
    meaning:
      "An outage or a rate limit on the provider's side; the send waits, retried at `retry_at`. No one is marked unsent.",
    remedy:
      "Nothing, while `info`: it retries on its own. At `warn` the deployment asks for more a second than the account allows: whoever runs it sets `SES_MAX_SEND_RATE` to the account's maximum send rate, and deploys.",
  },
  bounce_spike: {
    severity: "`warn`",
    fields: "`bounced`, `rate`",
    meaning: `A send finished within ${RECENT_DAYS} days whose confirmed bounces reached ${BOUNCE_SPIKE_RATE * 100}% of its audience at fire (at least ${BOUNCE_SPIKE_MIN}), where providers put a sender under review.`,
    remedy:
      "The publisher checks the addresses on its deliveries (`view=bounced`); a hard bounce is already suppressed. It warns only, never halting a send.",
  },
  no_receipts: {
    severity: "`warn`",
    fields: "`accepted`",
    meaning: `A send finished within ${RECENT_DAYS} days, ${NO_RECEIPTS_AFTER_MS / 60_000} minutes past dispatch, with no receipt for any of its \`accepted\`: the provider's events may not be reaching the webhook, so its bounces and complaints suppress no one.`,
    remedy:
      "Whoever runs the deployment looks for `webhook.refused` in the logs and checks the provider's event subscription. It clears once any receipt lands.",
  },
  remade: {
    severity: "`info`",
    fields: "`tested_at`",
    meaning:
      "A template or identity change re-made the scheduled email after its last test (`tested_at`, or null for none): its content and fire time are the same, its look may not be.",
    remedy: "A test of the post (`POST /api/posts/:id/test`) clears it.",
  },
  untested: {
    severity: "`info`",
    fields: "",
    meaning: "No test of the scheduled email has been sent, and it was never re-made.",
    remedy: "A test of the post (`POST /api/posts/:id/test`) clears it.",
  },
  daily_writes: {
    severity: "`warn`",
    fields: "`recipients`",
    meaning: `On the Workers Free plan's limits, a scheduled send to more than ${DAILY_WRITES_SEND_RECIPIENTS.toLocaleString("en-US")} recipients, judged by its audience alone, which may spend D1's daily written rows and stop the instance until midnight UTC.`,
    remedy:
      "Never a refusal: the send goes out as scheduled. Whoever runs the deployment can move to Workers Paid, whose limits a send this size fits.",
  },
};

/**
 * Every halt cause: which halt it is, and what it means in one line. A Record over
 * `HaltCause`, so a new cause fails to compile until it is described. Its fix is not here: the
 * provider's adapter words it (`refusalAdvice`), and the send's `refused` condition carries
 * those words as `advice`, to relay as they stand.
 */
const HALT_CAUSES: Record<HaltCause, { reason: HaltReason; meaning: string }> = {
  outage: { reason: "unavailable", meaning: "The provider is down." },
  rate_limit: {
    reason: "unavailable",
    meaning:
      "The provider refused for its sending rate; once it keeps happening, `SES_MAX_SEND_RATE` is set above the account's maximum.",
  },
  credentials: {
    reason: "account",
    meaning: "The provider refused the deployment's key, or its permissions.",
  },
  opt_in: {
    reason: "account",
    meaning: "The provider account isn't signed up or activated for sending.",
  },
  configuration: {
    reason: "account",
    meaning: "The configuration set the deployment names doesn't exist.",
  },
  sending_pool: {
    reason: "account",
    meaning: "The configuration set sends through an IP pool the provider can't find.",
  },
  unsupported: {
    reason: "account",
    meaning: "The provider read the request as asking for something Kestrel never sends.",
  },
  sender: { reason: "account", meaning: "The From address, or its domain, isn't verified." },
  mail_from: {
    reason: "account",
    meaning: "The sending domain isn't verified, or its MAIL FROM domain can't be read.",
  },
  sandbox: {
    reason: "account",
    meaning: "The account is in the provider's sandbox, which mails only verified addresses.",
  },
  quota: { reason: "account", meaning: "The account's sending quota for the day is used up." },
  suspended: { reason: "account", meaning: "The provider has shut down the account's sending." },
  paused: { reason: "account", meaning: "Sending is paused for the account." },
  set_paused: { reason: "account", meaning: "Sending is turned off on the configuration set." },
  not_connected: { reason: "account", meaning: "No email provider is connected." },
  content: {
    reason: "account",
    meaning: "The provider refuses this email itself; no other send waits on it.",
  },
  invalid_request: {
    reason: "account",
    meaning: "The provider refused a batch of this send as invalid; no other send waits on it.",
  },
};

/** The condition object's table: each kind, with its severity, fields, meaning, and remedy. */
const CONDITION_TABLES: ReferenceTable[] = [
  {
    title: "Condition kinds",
    description:
      "Each `kind`. Show its `message` as it stands; this says what it means and what settles it.",
    columns: ["Kind", "Severity", "Fields", "Meaning", "Remedy"],
    rows: (Object.keys(CONDITION_KINDS) as ConditionKind[]).map((kind) => {
      const k = CONDITION_KINDS[kind];
      return [`\`${kind}\``, k.severity, k.fields || "none", k.meaning, k.remedy];
    }),
  },
];

const CONDITION_FIELDS: ReferenceField[] = [
  {
    name: "kind",
    type: "string",
    description: "Which condition: the table below says what each means and what settles it.",
  },
  {
    name: "severity",
    type: "string",
    description: "How much it asks of a person.",
    values: [
      { value: "action", description: "A person must act." },
      { value: "warn", description: "Worth a look." },
      { value: "info", description: "Worth knowing." },
    ],
  },
  {
    name: "since",
    type: "number | null",
    description: "When it began, or null when the record doesn't say.",
  },
  {
    name: "message",
    type: "string",
    description: "The server's words for it, to show as they stand, the same wherever it is shown.",
  },
  {
    name: "action",
    type: "{ name, method, path } | null",
    description:
      "The act on the send that settles it (Resolve, for `wedged`), or null when none does.",
  },
  {
    name: "…",
    type: "",
    description:
      "The fields its kind carries, as the table's Fields column names (`count` on `wedged`).",
  },
];

const HALT_FIELDS: ReferenceField[] = [
  {
    name: "reason",
    type: "string",
    description: "Which halt, and how often it retries.",
    values: [
      {
        value: "unavailable",
        description: `An outage or a rate limit, retried ${retrySchedule(HALT_BACKOFF_MS.unavailable)}.`,
      },
      {
        value: "account",
        description: `The provider refusing the account, or this send's own email, retried ${retrySchedule(HALT_BACKOFF_MS.account)}. The fix is outside this API; the send resumes once it lands.`,
      },
    ],
  },
  {
    name: "cause",
    type: "string | null",
    description:
      "What the provider refused for. An `unavailable` halt's cause clears on its own; an `account` halt's fix, in words to relay, is the `advice` on the send's `refused` condition.",
    values: (Object.keys(HALT_CAUSES) as HaltCause[]).map((cause) => ({
      value: cause,
      description: HALT_CAUSES[cause].meaning,
      group: `An \`${HALT_CAUSES[cause].reason}\` halt`,
    })),
  },
  { name: "error", type: "string", description: "The provider's own words." },
  { name: "retries", type: "number", description: "How many runs in a row it has halted." },
  { name: "since", type: "number | null", description: "When the refusals began." },
  {
    name: "retry_at",
    type: "number | null",
    description: "When the next retry is due; nothing retries it sooner.",
  },
];

const SEND_FIELDS: ReferenceField[] = [
  { name: "id", type: "string", description: "The send's id." },
  { name: "post_id", type: "string", description: "The post it sends." },
  { name: "subject", type: "string", description: "The frozen email's subject." },
  {
    name: "status",
    type: "string",
    description:
      "The stored lifecycle, changed only by a write: what to filter on (`?status=`) and route on. `phase` refines it for display.",
    values: [
      { value: "scheduled", description: "Cancelable until `fire_at`." },
      { value: "sending", description: "Fired, handing recipients to the provider." },
      { value: "sent", description: "Every recipient accounted for." },
      { value: "canceled", description: "Canceled in its review window." },
    ],
  },
  {
    name: "email_only",
    type: "boolean",
    description:
      "The post's listing: true when left out of the archive. The editor's \"Include in archive\", unchecked.",
  },
  {
    name: "web_link",
    type: '"unlisted" | "archive"',
    description:
      "Which address the email links as view-in-browser (`archive` for a send frozen before unlisted links).",
  },
  {
    name: "rev",
    type: "number",
    description: "Its last change's place in one sequence across all sends: higher is newer.",
  },
  {
    name: "as_of",
    type: "number",
    description: "The server's clock at the read, which the derived fields are as of.",
  },
  { name: "fire_at", type: "number", description: "When it fires or fired, on the minute." },
  { name: "scheduled_at", type: "number", description: "When it was scheduled." },
  { name: "started_at", type: "number | null", description: "When its first run started." },
  { name: "completed_at", type: "number | null", description: "When it finished." },
  {
    name: "remade_at",
    type: "number | null",
    description: "When a template or identity change last re-made its email while scheduled.",
  },
  {
    name: "tested_at",
    type: "number | null",
    description: "When its frozen copy was last tested while scheduled.",
  },
  {
    name: "audience",
    type: "{ count, fixed, fixed_at }",
    description:
      "`count` is an estimate while scheduled, and the audience at fire once `fixed` (from `fixed_at`), which never grows.",
  },
  {
    name: "counts",
    type: "object",
    description:
      "Every recipient in one bucket: `pending`, `in_flight`, `accepted`, `delivered`, `bounced`, `complained`, `skipped`, `unsent`.",
  },
  {
    name: "dispatch",
    type: "{ done, percent, rate_per_min, eta_ms }",
    description:
      "Hand-off progress. `rate_per_min` is a sweep tick's (one a minute); `eta_ms` counts the ticks left, only while handing off.",
  },
  {
    name: "delivery",
    type: "{ confirmed, percent_of_accepted }",
    description: "Delivery receipts over the recipients the provider accepted.",
  },
  {
    name: "provider.name",
    type: "string",
    description: "The provider: `ses`, or `fake` locally.",
  },
  {
    name: "provider.halt",
    type: "halt | null",
    object: "halt",
    description:
      "While the provider refuses the send's batches as a whole, else null; it retries on its own.",
  },
  {
    name: "phase",
    type: "string",
    description:
      "The live reading of `status`, derived as of `as_of` and never stored, so it is for showing, not filtering. Each value belongs to one `status`: `scheduled` is `scheduled` or `due`; `sending` is `progressing`, `retrying`, `backing-off`, or `needs-attention`; `sent` is `settling` or `complete`; `canceled` is `canceled`. What needs a person is in `conditions`.",
    values: [
      { value: "scheduled", description: "In its review window." },
      {
        value: "due",
        description:
          "Its fire time has passed; the next sweep starts it. A missed send stays here.",
      },
      {
        value: "progressing",
        description: "Handing recipients to the provider. A stuck send stays here.",
      },
      { value: "retrying", description: "Handing off, with recipients being retried." },
      {
        value: "backing-off",
        description:
          "Waiting out an `unavailable` halt, or recipients waiting on a transient retry with nothing in flight.",
      },
      {
        value: "needs-attention",
        description: "Waiting on a person: wedged, or refused by the provider.",
      },
      { value: "settling", description: "Dispatched, with receipts still arriving." },
      { value: "complete", description: "Every accepted recipient confirmed." },
      { value: "canceled", description: "Canceled." },
    ],
  },
  {
    name: "conditions",
    type: "condition[]",
    object: "condition",
    description: "What is wrong with the send, or worth knowing, now, most severe first.",
  },
  {
    name: "actions",
    type: "object[]",
    description:
      "What the server would accept now, each `{ name, method, path }`: `cancel` and `reschedule` before the fire time, `resolve` while wedged.",
  },
  {
    name: "next_change_at",
    type: "number | null",
    description:
      "The earliest it can change with no one acting: at or before `as_of` while it can move now; null when only an act or a receipt can.",
  },
  {
    name: "links",
    type: "object",
    description:
      "`self`, the frozen email (`email_html`, `email_text`), the rows (`deliveries`, `deliveries_csv`), `post`, and, absolute, `archive` while it answers and `unlisted`.",
  },
];

const POST_EXAMPLE = {
  id: "p_abc123",
  slug: "hello-world",
  slug_auto: true,
  unlisted_token: "9f2c41d0-7ab35e8c-6d1f04b2-a7e9c350",
  archive_url: "https://newsletter.example.com/archive/hello-world",
  unlisted_url: "https://newsletter.example.com/email/9f2c41d0-7ab35e8c-6d1f04b2-a7e9c350",
  published_at: null,
  archive_live: false,
  subject: "Hello, world",
  status: "draft",
  email_only: false,
  current_revision: "r_1",
  created_at: 1768381200000,
  updated_at: 1768381200000,
} satisfies Post;

const POST_FIELDS: ReferenceField[] = [
  { name: "id", type: "string", description: "The post's id." },
  { name: "subject", type: "string", description: "The subject line, and the post's title." },
  {
    name: "status",
    type: "string",
    description:
      "Where the post stands. It stays `scheduled` while its send is going out, so whether it is public is `published_at`.",
    values: [
      { value: "draft", description: "Editable." },
      { value: "scheduled", description: "Soft-locked under a scheduled or sending send." },
      { value: "sent", description: "Its send finished." },
    ],
  },
  {
    name: "slug",
    type: "string",
    description:
      "The last part of its archive address: unique among all posts, drafts included, and fixed once its send starts.",
  },
  {
    name: "slug_auto",
    type: "boolean",
    description:
      "Whether the slug follows the subject on every draft save, taking the first free number (`-2`) when another post holds it. False once set by hand.",
  },
  {
    name: "email_only",
    type: "boolean",
    description:
      'The listing: true when mailed but left out of the archive index and home page, its archive address answering nothing. The editor\'s "Include in archive", unchecked. Changes in any state.',
  },
  {
    name: "unlisted_token",
    type: "string",
    description: "Its unlisted link is `<app origin>/email/<unlisted_token>`, never changed.",
  },
  {
    name: "unlisted_url",
    type: "string",
    description:
      "The unlisted link, absolute: the view-in-browser every test and send carries. It opens the post once `published_at` is set.",
  },
  {
    name: "archive_url",
    type: "string",
    description:
      "The archive address, absolute, whether or not it answers yet: where a listed post is published once its send starts.",
  },
  {
    name: "published_at",
    type: "number | null",
    description: "When its send started, which is when it was published; null before.",
  },
  {
    name: "archive_live",
    type: "boolean",
    description:
      "Whether `archive_url` shows the post now. A reader sees it there when true, otherwise at `unlisted_url` once published; which to share is the publisher's call.",
  },
  {
    name: "current_revision",
    type: "string | null",
    description: "The current revision's id, which a save names as `base_revision`.",
  },
  { name: "created_at", type: "number", description: "When it was made." },
  { name: "updated_at", type: "number", description: "When it last changed." },
];

const REVISION_FIELDS: ReferenceField[] = [
  { name: "n", type: "number", description: "Its number, from 1, oldest first." },
  { name: "id", type: "string", description: "Its id, which a save names as `base_revision`." },
  {
    name: "author",
    type: "string | null",
    description: "Who saved it: an email, or `service` for Claude.",
  },
  { name: "created_at", type: "number", description: "When it was saved." },
  { name: "metadata", type: "object", description: "The subject and slug it was saved with." },
  { name: "markdown", type: "string", description: "Its body; on one revision's read only." },
  {
    name: "is_current",
    type: "boolean",
    description: "Whether it is the post's current revision; in the history only.",
  },
];

/** A subscriber's status and what it means, in the editor legend's words. */
const STATUS_VALUES = (Object.keys(STATUS_MEANING) as SubscriberStatus[]).map((status) => ({
  value: status,
  description: STATUS_MEANING[status],
}));

/**
 * Where each suppression reason comes from, beside the flag the editor shows it as and that
 * flag's meaning in the legend's words: an import's bounce or complaint reads as one seen
 * here, so it names the reason it reads as, and only its source tells the two apart.
 */
const REASON_SOURCE: Record<SuppressionReason, string> = {
  bounce: "The provider reported a hard bounce here.",
  import_bounce: "An import carried it in from the service the list came from.",
  complaint: "The provider reported a spam complaint here.",
  import_complaint: "An import carried it in from the service the list came from.",
  manual: "",
  erased: "",
};
const READS_AS: Partial<Record<SuppressionReason, SuppressionReason>> = {
  import_bounce: "bounce",
  import_complaint: "complaint",
};

/** The suppression reasons, each with the flag the editor shows and where it came from. */
const REASON_VALUES = (Object.keys(SUPPRESSION_FLAG) as SuppressionReason[]).map((reason) => {
  const flag: SuppressionFlag = SUPPRESSION_FLAG[reason];
  const same = READS_AS[reason];
  const meaning = flag === "erased" ? ERASED_MARKER_MEANING : FLAG_MEANING[flag];
  const lead = same ? `Shown as ${flag}, as \`${same}\` is.` : `Shown as ${flag}: ${meaning}`;
  return { value: reason, description: `${lead} ${REASON_SOURCE[reason]}`.trim() };
});

const SUBSCRIBER_FIELDS: ReferenceField[] = [
  { name: "id", type: "string", description: "The subscriber's id." },
  { name: "email", type: "string", description: "The address." },
  {
    name: "status",
    type: "string",
    description:
      "Consent, separate from suppression: a suppressed address is never mailed, whatever its status.",
    values: STATUS_VALUES,
  },
  {
    name: "suppressed",
    type: "boolean",
    description: `Whether the address is suppressed; in a list row, and beside \`subscriber\` in one subscriber's answer. ${SUPPRESSED_MEANING}`,
  },
  {
    name: "suppression_reason",
    type: "string | null",
    description: `Why, and whose decision it was, as a suppression's \`reason\` (Suppressions); in a list row. On the roster \`erased\` means: ${FLAG_MEANING.erased}`,
  },
  {
    name: "suppression_detail",
    type: "string | null",
    description: "The provider's words, or the publisher's; in a list row.",
  },
  {
    name: "origin",
    type: "string",
    description: "Where consent was collected: `kestrel`, or the source an import claimed.",
  },
  {
    name: "opt_in",
    type: '"double" | "single" | "unknown"',
    description: "How consent was collected: this app's is `double`.",
  },
  {
    name: "consent_evidence",
    type: "string | null",
    description: "The proof of consent, as JSON text.",
  },
  {
    name: "import_id",
    type: "string | null",
    description: "The import that confirmed or added them, or null when they joined here.",
  },
  { name: "created_at", type: "number", description: "When they joined." },
  { name: "confirmed_at", type: "number | null", description: "When they confirmed." },
  {
    name: "unsubscribed_at",
    type: "number | null",
    description: "When they last left, kept while they are pending again.",
  },
  {
    name: "confirm_token, unsub_token",
    type: "string",
    description:
      "The confirmation link's one-shot token (null once spent) and the unsubscribe link's, never rotated.",
  },
  {
    name: "confirm_sent_at, confirm_attempt_at",
    type: "number | null",
    description: "When a confirmation last went out, and was last attempted.",
  },
];

const SUPPRESSION_FIELDS: ReferenceField[] = [
  { name: "email", type: "string", description: "The address." },
  {
    name: "reason",
    type: "string",
    description: "Why, and whose decision it was.",
    values: REASON_VALUES,
  },
  {
    name: "detail",
    type: "string | null",
    description: "The provider's words, or the publisher's.",
  },
  { name: "created_at", type: "number", description: "When it was suppressed." },
];

const IMPORT_PLAN_FIELDS: ReferenceField[] = [
  {
    name: "file",
    type: "object",
    description:
      "What was read: `name`, `kind` (`csv` or `txt`), `rows`, `addresses`, and `plain_list_status`.",
  },
  {
    name: "counts",
    type: "object",
    description:
      "Every row once, by outcome, summing to `file.rows`. The outcomes and when each applies are in `GET /api/imports/format`.",
  },
  { name: "suppressions_added", type: "number", description: "Rows that add a suppression." },
  {
    name: "confirmed",
    type: "object",
    description: "The rows to be confirmed, by `opt_in` and by `origin`.",
  },
  {
    name: "rows",
    type: "object[]",
    description: "Each row that won't be confirmed, in file order, with its `outcome`.",
  },
  {
    name: "sends_growing",
    type: "object[]",
    description:
      "Each send whose audience would grow, with `gains`: a scheduled one, or one that fired but hasn't fixed its audience. A commit names each in `acknowledge_sends`.",
  },
  {
    name: "attestation",
    type: "object | null",
    description:
      "`{ version, text, publication }` when anyone would be confirmed, else null. `publication` is the name `text` calls the publication by.",
  },
  { name: "plan_hash", type: "string", description: "What the commit names, to apply this plan." },
  {
    name: "workers_plan_advice",
    type: "string | null",
    description: `On the Workers Free plan's limits, the server's words when this import would leave more than ${FREE_PLAN_LIST.toLocaleString("en-US")} confirmed subscribers, advising Workers Paid; else null. Never a refusal, and outside the hash.`,
  },
];

const SETTINGS_FIELDS: ReferenceField[] = [
  {
    name: "settings",
    type: "object",
    description:
      "The runtime preferences: `testRecipients`, `publication` (`name`, `tagline`, `address`, `logoUrl`), `emailTemplate`, `confirmationEmail` and its `confirmationEmailDefault`, and `notifications.to`. Never a secret.",
  },
  {
    name: "deployment",
    type: "object",
    description:
      "Deploy configuration, read-only: `provider`, the origins and addresses, `minLeadMs`, `authMode`, the `build`, and the fields below.",
  },
  {
    name: "deployment.provider",
    type: '"ses" | "fake" | "none"',
    description:
      "`fake` records a send and delivers nothing (local development, a demo); `none` while no provider is connected, when everything that would send is refused.",
  },
  {
    name: "deployment.notConnectedPreview",
    type: "boolean",
    description:
      "True when `none` is local development previewing the state, whose way out is a restart, not a deploy.",
  },
  {
    name: "deployment.freePlanLimits",
    type: "boolean",
    description:
      "True on the Workers Free plan's limits (`SUBREQUEST_BUDGET` unset): the import limit, the export's page, the `daily_writes` condition, and `workers_plan_advice` follow it.",
  },
  {
    name: "inUse",
    type: "object",
    description:
      "What a template or identity save would re-make: `sends`, every scheduled send, soonest first; `retry_after`, when a save stops being refused for the minimum lead (null when none is inside it); and `identityFields`, the identity fields the template renders, the only ones whose change reaches the email.",
  },
  {
    name: "notificationStatus",
    type: "object",
    description: "The last notification delivered and the last failure, if newer.",
  },
];

/**
 * Every object, in the order the reference lists them. A Record, so a new `ObjectKey` fails to
 * compile until it is described.
 */
export const OBJECTS: Record<ObjectKey, Omit<ReferenceObject, "key">> = {
  send: {
    resource: "sends",
    title: "The send view",
    description:
      "One send, the one shape every send route carries: the list, one send, the feed, and every act's answer and refusal. A client keeps one copy current from any of them and tells two apart by `rev`. The stored facts, with what the server derives from them as of `as_of`. Its email and its recipient rows have routes of their own.",
    fields: SEND_FIELDS,
    example: SEND_EXAMPLE,
  },
  condition: {
    resource: "sends",
    title: "The condition object",
    description:
      "One entry of a send's `conditions`: something wrong with the send, or worth knowing, now. The server derives it from the send's record, the same on every route.",
    fields: CONDITION_FIELDS,
    tables: CONDITION_TABLES,
    example: {
      kind: "wedged",
      severity: "action",
      since: 1768467600000,
      message:
        "The provider never answered for 3 recipients, so whether they were mailed is unknown, and sending again could mail them twice. The send cannot finish until they are resolved.",
      action: { name: "resolve", method: "POST", path: "/api/sends/s_xyz789/resolve" },
      count: 3,
    } satisfies SendCondition,
  },
  halt: {
    resource: "sends",
    title: "The halt object",
    description:
      "A send's `provider.halt`: the provider refusing the send's batches as a whole. The send retries on its own, consuming no recipient; a send that fires during another's halt joins it, unless the cause is its own (`content`, `invalid_request`).",
    fields: HALT_FIELDS,
    example: {
      reason: "account",
      cause: "sandbox",
      error: "Email address is not verified.",
      retries: 2,
      since: 1768467600000,
      retry_at: 1768471200000,
    } satisfies SendHalt,
  },
  post: {
    resource: "posts",
    title: "The post object",
    description:
      "A subject and a Markdown body, with its archive address and its unlisted link. Editable only as a draft; its settings (listing and address) change in any state.",
    fields: POST_FIELDS,
    example: POST_EXAMPLE,
  },
  revision: {
    resource: "posts",
    title: "The revision object",
    description: "One saved version of a post. Read-only.",
    fields: REVISION_FIELDS,
    example: {
      n: 1,
      id: "r_1",
      author: "you@example.com",
      created_at: 1768381200000,
      metadata: { subject: "Hello, world", slug: "hello-world" },
      markdown: "# Hello\n\nWelcome.",
    } satisfies RevisionResponse,
  },
  subscriber: {
    resource: "subscribers",
    title: "The subscriber object",
    description:
      "An address, its consent, its suppression, and how it joined. Consent status and suppression are separate axes.",
    fields: SUBSCRIBER_FIELDS,
    example: {
      id: "sub_1",
      email: "reader@example.com",
      status: "confirmed",
      confirm_token: null,
      confirm_sent_at: 1768381200000,
      confirm_attempt_at: 1768381200000,
      unsub_token: "6d1f04b2-a7e9c350-9f2c41d0-7ab35e8c",
      origin: "kestrel",
      opt_in: "double",
      consent_evidence: '{"confirmed_ip":"203.0.113.7"}',
      import_id: null,
      created_at: 1768381200000,
      confirmed_at: 1768381500000,
      unsubscribed_at: null,
      suppressed: false,
      suppression_reason: null,
      suppression_detail: null,
    } satisfies SubscriberListItem,
  },
  suppression: {
    resource: "suppressions",
    title: "The suppression object",
    description: `An address that isn't mailed, and why. ${SUPPRESSED_MEANING}`,
    fields: SUPPRESSION_FIELDS,
    example: {
      email: "reader@example.com",
      reason: "manual",
      detail: "Our own test address",
      created_at: 1760400000000,
    } satisfies Suppression,
  },
  import_plan: {
    resource: "imports",
    title: "The import plan",
    description:
      "What an import would do to every row against the list as it stands. A plan writes nothing; a commit applies it whole or not at all.",
    fields: IMPORT_PLAN_FIELDS,
    example: {
      file: {
        name: "subscribers.csv",
        kind: "csv",
        rows: 2,
        addresses: 2,
        plain_list_status: null,
      },
      counts: {
        create_confirmed: 1,
        confirm_pending: 0,
        unchanged: 0,
        mark_unsubscribed: 0,
        create_unsubscribed: 1,
        kept_confirmed_newer: 0,
        kept_unsubscribed: 0,
        blocked_by_suppression: 0,
        suppression_added: 0,
        left_out: 0,
        invalid: 0,
        merged: 0,
      },
      suppressions_added: 0,
      confirmed: { opt_in: { double: 1, single: 0, unknown: 0 }, origin: { sendy: 1 } },
      rows: [
        {
          row: 2,
          email: "edsger@example.com",
          outcome: "create_unsubscribed",
          suppression_added: false,
        },
      ],
      sends_growing: [
        { id: "s_xyz789", subject: "Spring migration", fire_at: 1768554000000, gains: 1 },
      ],
      attestation: {
        version: 1,
        text: "Everyone I'm importing as subscribed opted in to receive Field Notes. This isn't a purchased, rented, or scraped list.",
        publication: "Field Notes",
      },
      plan_hash: "9f2c…",
      workers_plan_advice: null,
    } satisfies ImportPlanResponse,
  },
  settings: {
    resource: "settings",
    title: "The settings object",
    description:
      "The runtime preferences, one resource that never holds a secret, with deploy configuration reflected read-only.",
    fields: SETTINGS_FIELDS,
    example: {
      settings: { emailTemplate: "…", publication: { name: "Marsh Lane" } },
      deployment: { provider: "ses", minLeadMs: 300000, freePlanLimits: false },
      inUse: {
        sends: [
          {
            id: "s_xyz789",
            post_id: "p_abc123",
            subject: "Hello, world",
            fire_at: 1768467600000,
            remade_at: null,
          },
        ],
        retry_after: null,
        identityFields: ["name", "tagline", "logoUrl", "address"],
      },
      notificationStatus: { lastSent: null, lastFailure: null },
    } satisfies Abridged<SettingsResponse>,
  },
};

/** The objects as the reference lists them. */
export function referenceObjects(): ReferenceObject[] {
  return (Object.keys(OBJECTS) as ObjectKey[]).map((key) => ({ key, ...OBJECTS[key] }));
}
