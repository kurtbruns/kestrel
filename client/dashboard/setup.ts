// The dashboard's setup steps (DESIGN §3, SPEC §13): the ten steps from deployed to the first
// post, each read from a fact both clients can read, and their markup as the first-run
// checklist or the Finish setting up card.

import type { ProviderStatusView } from "../../shared/provider";
import type { SendView } from "../../shared/sends";
import { CONNECT_PROVIDER_HREF } from "../deployment";
import {
  inSandbox,
  PRODUCTION_ACCESS_HREF,
  productionAccessHint,
  TEMPLATE_TEST_HREF,
} from "../provider_status";
import { copyFace } from "../ui/copy";
import { fmt } from "../ui/format";
import { type Html, html } from "../ui/html";

/**
 * What the steps read, each a fact the editor and Claude both have: the deployment and the
 * provider's status (GET /api/provider, with whether email is getting out and whether signups
 * are open), the settings and their notification status, the list's counts, the posts, and the
 * first post's scheduled send. Nothing here is setup state of its own, so nothing is ticked by
 * hand and Claude can say the same without rebuilding the card.
 */
export interface SetupFacts {
  /** No provider is named, so nothing can be sent (SPEC §13). */
  notConnected: boolean;
  /** SES, or local dev simulating it: an account whose sandbox AWS reviews. */
  sesAccount: boolean;
  /** GET /api/provider, or null when it isn't read or the read failed. */
  provider: ProviderStatusView | null;
  /** The publication's name as readers see it, and whether one has been set. */
  name: string;
  named: boolean;
  /** How many addresses notifications go to. */
  notifyTo: number;
  /** The last notification failed, with none delivered since. */
  notifyFailed: boolean;
  /** Confirmed and pending subscribers on the list. */
  onList: number;
  /** A post meant for the archive exists: an email-only one, such as Verify it works', doesn't count. */
  wrote: boolean;
  /** The soonest scheduled send of a post meant for the archive, or null. */
  firstSend: SendView | null;
  /** The public subscribe page's address. */
  subscribeUrl: string;
}

/**
 * Where a step stands. `done` folds into the card's one line. `todo` can be taken now.
 * `attention` can be taken but a problem the health block states is in its way. `waiting`
 * waits on AWS, not on the publisher. `blocked` can't be taken until an earlier step is.
 */
export type SetupStepState = "done" | "todo" | "attention" | "waiting" | "blocked";

export type SetupStepKey =
  | "connect"
  | "test"
  | "name"
  | "notify"
  | "access"
  | "list"
  | "write"
  | "schedule"
  | "post_test"
  | "share";

/** One step, as the card shows it. */
export interface SetupStep {
  key: SetupStepKey;
  title: string;
  state: SetupStepState;
  /** The line under the title, or null for none. */
  hint: string | null;
  /** What the fold line calls it once done. */
  doneAs: string;
}

const CONNECT = "Connect Amazon SES";
const TEST = "Send a test email";
const SCHEDULE = "Schedule your first post";

/** "After <step>", a blocked step's whole hint: the step it waits for, in plain words. */
const after = (title: string) => `After ${title}`;

/** The pointer a step gives while the health block states what's in its way. */
const REFUSING = "SES is refusing. The fix is above.";

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The ten steps, in order. Each is done only from what the facts say, and blocked only when
 * it truly can't be taken: sending before SES is connected, the first post's test before it is
 * scheduled, and sharing before signups are open. Production access is never blocked, and
 * scheduling and sharing in the sandbox are allowed, with a hint to wait.
 */
export function setupSteps(f: SetupFacts): SetupStep[] {
  const p = f.provider;
  const sending = p?.sending ?? null;
  const sandbox = inSandbox(p);
  const steps: SetupStep[] = [];

  steps.push({
    key: "connect",
    title: CONNECT,
    state: f.notConnected ? "todo" : "done",
    hint: f.notConnected
      ? "Nothing can be sent, and signups stay closed, until SES is connected."
      : null,
    doneAs: "Amazon SES connected",
  });

  steps.push(
    f.notConnected
      ? { key: "test", title: TEST, state: "blocked", hint: after(CONNECT), doneAs: "" }
      : sending?.state === "working"
        ? {
            key: "test",
            title: TEST,
            state: "done",
            hint: null,
            doneAs: sending.last_accepted?.by === "test" ? "a test email sent" : "email going out",
          }
        : sending?.state === "refusing"
          ? { key: "test", title: TEST, state: "attention", hint: REFUSING, doneAs: "" }
          : {
              key: "test",
              title: TEST,
              state: "todo",
              hint: sending
                ? `SES is connected but hasn’t sent anything yet. Send one to ${sandbox ? "an address verified in SES" : "yourself"}.`
                : "Send one to yourself, and check it arrives.",
              doneAs: "",
            },
  );

  steps.push({
    key: "name",
    title: "Name your publication",
    state: f.named ? "done" : "todo",
    hint: f.named ? null : `Currently “${f.name}”.`,
    doneAs: `named ${f.name}`,
  });

  steps.push({
    key: "notify",
    title: "Get notified",
    state: !f.notifyTo ? "todo" : f.notifyFailed ? "attention" : "done",
    hint: !f.notifyTo
      ? "Kestrel emails you when a send finishes or needs you."
      : f.notifyFailed
        ? "The last notification didn’t arrive. Settings says why."
        : null,
    doneAs: `notifications to ${plural(f.notifyTo, "address", "addresses")}`,
  });

  if (f.notConnected || f.sesAccount) {
    steps.push({
      key: "access",
      title: "Request production access",
      state:
        p?.state === "production"
          ? "done"
          : sandbox && p?.review === "pending"
            ? "waiting"
            : "todo",
      hint: productionAccessHint(p, f.named, !f.notConnected),
      doneAs: "production access",
    });
  }

  steps.push({
    key: "list",
    title: "Bring your existing list",
    state: f.onList ? "done" : "todo",
    hint: f.onList ? null : "Optional.",
    doneAs: `${plural(f.onList, "subscriber", "subscribers")} on your list`,
  });

  steps.push({
    key: "write",
    title: "Write your first post",
    state: f.wrote ? "done" : "todo",
    hint: null,
    doneAs: "your first post written",
  });

  steps.push({
    key: "schedule",
    title: SCHEDULE,
    state: f.notConnected ? "blocked" : f.firstSend ? "done" : "todo",
    hint: f.notConnected
      ? after(CONNECT)
      : sandbox && !f.firstSend
        ? "Best after AWS grants access: until then it reaches only verified addresses."
        : null,
    doneAs: "your first post scheduled",
  });

  // The test of the frozen email that will go out, recorded on the send; a draft's test is a
  // preview and isn't counted. A re-make since the last test makes the email new again.
  const s = f.firstSend;
  const tested = s ? s.tested_at !== null && (s.remade_at ?? 0) <= s.tested_at : false;
  steps.push({
    key: "post_test",
    title: "Send a test email for your first post",
    state: !s ? "blocked" : tested ? "done" : "todo",
    hint: !s
      ? after(SCHEDULE)
      : tested
        ? null
        : `“${s.subject}” goes out ${fmt(s.fire_at)}. Send yourself a test of it first.`,
    doneAs: "your first post tested",
  });

  // Sharing can't be known, so it's never done; it waits only for signups to open.
  const closed = f.notConnected || (p !== null && p.signups !== "open");
  steps.push({
    key: "share",
    title: "Share your subscribe link",
    state: closed ? "blocked" : "todo",
    hint: closed ? after(TEST) : sandbox ? "Share it once AWS grants production access." : null,
    doneAs: "",
  });

  return steps;
}

/** The fold line: every done step by name while there are few, else the count and the latest two. */
function foldHtml(done: SetupStep[]): Html {
  const n = done.length;
  const words =
    n <= 4
      ? html`<strong>${n} done:</strong> ${done.map((d) => d.doneAs).join(", ")}`
      : html`<strong>${n} done</strong>, including ${done
          .slice(-2)
          .map((d) => d.doneAs)
          .join(" and ")}`;
  return html`<p class="setup-fold"><span class="setup-fold-mark" aria-hidden="true">✓</span><span>${words}</span></p>`;
}

/** The step's control: where it's taken, or nothing for a step that waits or can't be. */
function stepAction(step: SetupStep, f: SetupFacts, primary: boolean): Html | null {
  if (step.state === "blocked") {
    return null;
  }
  const cls = primary ? "primary" : "";
  switch (step.key) {
    case "connect":
      return html`<button class="${cls}" data-nav="${CONNECT_PROVIDER_HREF}">Connect</button>`;
    case "test":
      return html`<button class="${cls}" data-nav="${TEMPLATE_TEST_HREF}">Send test email</button>`;
    case "name":
    case "notify":
      return html`<button class="${cls}" data-nav="#/settings">Settings</button>`;
    case "access":
      return html`<button class="${cls}" data-nav="${PRODUCTION_ACCESS_HREF}">Docs</button>`;
    case "list":
      return html`<button class="${cls}" data-nav="#/subscribers/import">Import</button>`;
    case "write":
      return html`<button class="${cls}" data-act="new-post">New post</button>`;
    case "schedule":
      return null; // scheduling is the post's, from its editor
    case "post_test":
      return f.firstSend
        ? html`<button class="${cls}" data-nav="#/edit/${f.firstSend.post_id}">Send test</button>`
        : null;
    case "share":
      return html`<button class="${cls}" type="button" data-copy="${f.subscribeUrl}" aria-label="Copy the subscribe link">${copyFace()}</button>`;
  }
}

/**
 * The setup steps, in one of two layouts: the first-run `checklist` that stands in for the
 * dashboard until the first post, and the compact `card` the regular dashboard carries until the
 * first post listed in the archive is published. One list, so the two can't drift. Finished steps
 * fold into one line above the rest, so the list starts at what's left; the first step that can
 * be taken now is marked as the one to take, and on the checklist, where the head carries no New
 * post, its button is the view's Primary. The Publishing docs' section of the same name
 * (docs/publishing/README.md) follows these steps, so a change here changes it.
 */
export function setupStepsHtml(f: SetupFacts, layout: "checklist" | "card"): Html {
  const steps = setupSteps(f);
  const done = steps.filter((s) => s.state === "done");
  const left = steps.filter((s) => s.state !== "done");
  const current = left.find((s) => s.state === "todo" || s.state === "attention");
  return html`<div class="card setup${layout === "card" ? " setup-card" : ""}">
    <h2 class="setup-title">${layout === "card" ? "Finish setting up" : "Set up your publication"}</h2>
    ${done.length ? foldHtml(done) : null}
    <ol class="setup-steps">${left.map(
      (s) =>
        html`<li class="setup-${s.key.replace("_", "-")} setup-${s.state}${s === current ? " setup-current" : ""}"><div class="setup-step-main"><strong>${s.title}</strong>${
          s.hint ? html`<span class="muted setup-hint">${s.hint}</span>` : null
        }${
          s.key === "share" && s.state !== "blocked"
            ? html`<code class="setup-url">${f.subscribeUrl}</code>`
            : null
        }</div>${stepAction(s, f, layout === "checklist" && s === current)}</li>`,
    )}</ol>
  </div>`;
}

/** The first post's send: the soonest scheduled send of a post meant for the archive. */
export function firstListedSend(sends: SendView[]): SendView | null {
  return (
    sends
      .filter((s) => s.status === "scheduled" && !s.email_only)
      .sort((a, b) => a.fire_at - b.fire_at)[0] ?? null
  );
}
