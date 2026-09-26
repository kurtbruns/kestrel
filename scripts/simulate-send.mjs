#!/usr/bin/env node
/*
 * Simulate a send on the local dev server: `npm run simulate-send -- --in 90s`.
 *
 * A thin script over the real API, as the seed is: it mints a dev token, seeds the demo
 * when the database is empty, and moves the demo's scheduled post to the requested time
 * through the reschedule route (or, when the demo's post has already gone out, creates a
 * post and schedules it through the schedule route). Then it prints the watch URL. Nothing
 * about the send is special: the server rounds its fire time up to the whole minute, and it
 * fires at the sweep tick on that minute, as a deployed send does (`npm run dev` runs the
 * sweep once a minute, on the minute), and the simulation profile the server runs
 * (`SIMULATE_SENDS`) paces and answers it.
 *
 *   --in <duration>   when it fires: 90s, 2m, 1m30s, 1h (default: the server's minimum
 *                     lead, the soonest any send may fire), then rounded up to the minute
 *                     by the server, as every fire time is. Inside the lead is refused.
 *   --profile <name>  resend, ses, or generic: checks the server runs that profile. The
 *                     profile is fixed when the server starts (`SIMULATE_SENDS=ses npm run
 *                     dev`), so this explains how to switch rather than switching.
 *   --size <n>        the list size to seed an empty database with (100 / 1k / 10k / 100k).
 *   --punctual        stay until the send comes due, run one extra sweep tick then, and say
 *                     whether it started, rather than leave it to the server's own tick that
 *                     minute. A dev tool's extra tick: the app behaves as it always does.
 *
 * The target is this worktree's dev server, as for the seed; override it with `PORT` or a
 * URL or port argument.
 */
import { baseUrl, callApi, devToken, fail, parseArgs } from "./dev-api.mjs";
import { seedDemo } from "./seed.mjs";
import { triggerSweep } from "./sweep-ticker.mjs";

const TAG = "simulate-send";
/** The demo's scheduled post (src/dev/seed.ts): the one a demo send moves when it can. */
const DEMO_SCHEDULED_SLUG = "a-quick-note";
/** Covers the request's trip, so a send asked for exactly one lead out isn't refused as
 *  just inside it by the time the server reads the clock. */
const SLACK_MS = 2000;
const PROFILES = { generic: "a generic provider", resend: "Resend", ses: "Amazon SES" };

/** `90s`, `2m`, `1m30s`, `1h`, or a bare number of seconds, in milliseconds; null if not. */
function parseDuration(raw) {
  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    return Number(s) * 1000;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || s === "") {
    return null;
  }
  const [, h = "0", min = "0", sec = "0"] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
}

/** A duration in words: "1 minute", "90 seconds", "2 minutes". */
function words(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString();

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), ["punctual"]);
  const base = baseUrl(positional[0]);
  const token = await devToken(base, TAG);
  const api = (path, init = {}) => callApi(base, token, path, { ...init, tag: TAG });

  const settings = await api("/api/settings");
  if (!settings.ok) {
    fail(
      TAG,
      `could not read the server's settings: ${settings.status}`,
      JSON.stringify(settings.body),
    );
  }
  const { minLeadMs, simulation } = settings.body.deployment;

  // The simulation is the server's to run, fixed when it starts.
  const wanted = flags.profile === "1" ? "generic" : flags.profile;
  if (wanted !== undefined && !(wanted in PROFILES)) {
    fail(
      TAG,
      `--profile must be one of ${Object.keys(PROFILES).join(", ")}, not "${flags.profile}"`,
    );
  }
  if (!simulation) {
    fail(
      TAG,
      "this dev server isn't simulating sends (SIMULATE_SENDS is off), so a send would finish at once with nothing to watch.",
      `Restart it with a profile: SIMULATE_SENDS=${wanted ?? "resend"} npm run dev`,
    );
  }
  if (wanted !== undefined && wanted !== simulation.profile) {
    fail(
      TAG,
      `this dev server simulates ${PROFILES[simulation.profile]}, not ${PROFILES[wanted]}. The profile is fixed when the server starts.`,
      `Stop it and run: SIMULATE_SENDS=${wanted} npm run dev   (or set SIMULATE_SENDS in .dev.vars)`,
    );
  }

  // The fire time: never inside the minimum lead, which every send gets (docs/SPEC.md §6).
  const inMs = flags.in === undefined ? minLeadMs : parseDuration(flags.in);
  if (inMs === null) {
    fail(TAG, `--in takes a duration like 90s, 2m, or 1m30s, not "${flags.in}"`);
  }
  if (inMs < minLeadMs) {
    const lower =
      minLeadMs > 60_000
        ? ` This server's lead is MIN_LEAD_SECONDS in .dev.vars; it can go as low as 60, the floor.`
        : "";
    fail(
      TAG,
      `--in ${flags.in} is inside this server's minimum lead of ${words(minLeadMs)}.`,
      `Every send stays visible and cancelable at least that long before it fires, so it can be stopped (docs/SPEC.md §6).`,
      `The floor is 1 minute in every environment, local dev included: the send sweep runs once a minute, so under that the tick, not the lead, would decide when a send fires.${lower}`,
    );
  }

  // An empty database gets the demo, as `npm run seed` loads it.
  const [postList, subscriberList] = await Promise.all([
    api("/posts?limit=1"),
    api("/subscribers?limit=1"),
  ]);
  const empty = postList.body?.page?.total === 0 && subscriberList.body?.page?.total === 0;
  if (empty) {
    console.log(`[${TAG}] the database is empty; loading the demo first…`);
    await seedDemo(base, token, { size: flags.size }, TAG);
  } else if (flags.size !== undefined) {
    fail(
      TAG,
      "--size applies only when the database is empty and gets seeded; this one already has data.",
      `Run \`npm run seed -- --size ${flags.size}\` (it replaces the local data), then run this again.`,
    );
  }

  // The demo's scheduled post, moved; or a new post, scheduled. The fire time is read at the
  // call that sets it: read before the scan below, the scan's round trips would eat the
  // slack, and a send asked for exactly one lead out would be refused as inside it.
  const fireAt = () => new Date(Date.now() + inMs + SLACK_MS).toISOString();
  const scheduled = await api("/sends?status=scheduled&sort=fire&dir=asc&limit=100");
  let demo = null;
  for (const send of scheduled.body?.sends ?? []) {
    const post = await api(`/posts/${send.post_id}`);
    if (post.body?.post?.slug === DEMO_SCHEDULED_SLUG) {
      demo = send;
      break;
    }
  }
  let send;
  if (demo) {
    const moved = await api(`/sends/${demo.id}/reschedule`, {
      method: "POST",
      json: { fire_at: fireAt() },
    });
    if (!moved.ok) {
      fail(
        TAG,
        `the reschedule was refused (${moved.status}): ${moved.body?.message ?? JSON.stringify(moved.body)}`,
      );
    }
    send = moved.body.send;
  } else {
    const stamp = new Date().toLocaleString();
    const created = await api("/posts", {
      method: "POST",
      json: {
        subject: `A simulated send, ${stamp}`,
        markdown: `# A simulated send\n\nScheduled by \`npm run simulate-send\` at ${stamp}, to watch a send go out on the local dev server the way it would deployed.`,
      },
    });
    if (!created.ok) {
      fail(TAG, `could not create a post (${created.status}): ${JSON.stringify(created.body)}`);
    }
    const frozen = await api(`/posts/${created.body.post.id}/schedule`, {
      method: "POST",
      json: { fire_at: fireAt() },
    });
    if (!frozen.ok) {
      fail(
        TAG,
        `the schedule was refused (${frozen.status}): ${frozen.body?.message ?? JSON.stringify(frozen.body)}`,
      );
    }
    send = frozen.body.send;
  }

  const confirmed = (await api("/subscribers?limit=1")).body?.counts?.confirmed ?? 0;
  const watch = `${base}/dashboard/#/sent/${send.id}`;
  console.log(
    `[${TAG}] "${send.subject}" is scheduled for ${clock(send.fire_at)}, to ${confirmed} confirmed subscriber${confirmed === 1 ? "" : "s"}.`,
  );
  console.log(
    `  simulating ${PROFILES[simulation.profile]}${simulation.faults === "none" ? " with no injected failures" : ", with a real provider's failures"}`,
  );
  // The server stores a fire time on the minute (docs/SPEC.md §6), and the sweep ticks on
  // the minute, so the time it answered is when the send starts.
  if (flags.punctual) {
    console.log(`  it fires at ${clock(send.fire_at)}: this script runs one extra sweep tick then`);
  } else {
    console.log(
      `  it fires at ${clock(send.fire_at)}, on that minute's sweep tick, as a deployed send would (a fire time is rounded up to the whole minute)`,
    );
  }
  if (simulation.profile === "ses") {
    console.log(
      "  SES takes one recipient per request, so on the default SUBREQUEST_BUDGET (Workers Free)\n" +
        "  it goes out a slice a minute, as deployed. Run `SUBREQUEST_BUDGET=10000 npm run dev`\n" +
        "  (with SIMULATE_SENDS=ses) to model Workers Paid.",
    );
  }
  if (confirmed === 0) {
    console.log("  no one is confirmed, so the send will have no one to go to");
  }
  console.log(`  watch it: ${watch}  (the post, until it fires; then the send)`);

  if (flags.punctual) {
    const wait = Math.max(0, send.fire_at - Date.now());
    await new Promise((r) => setTimeout(r, wait));
    const ok = await triggerSweep(base);
    console.log(
      ok
        ? `[${TAG}] it came due; ran a sweep tick, so it is sending now.`
        : `[${TAG}] it came due, but the sweep tick got no answer; the next minute's tick will fire it.`,
    );
  }
}

main();
