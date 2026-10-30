import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderStatusView } from "../../shared/provider";
import type { SendView } from "../../shared/sends";
import { sendView } from "../test/send_server";
import { providerStatus, resetShell, sendSummary } from "../test/support";
import { fmt } from "../ui/format";
import { html, setHtml } from "../ui/html";
import { type SetupFacts, type SetupStep, setupSteps, setupStepsHtml } from "./setup";

// DESIGN §3, SPEC §13: the ten setup steps, read from facts both clients have, in each phase.

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  notConnected: false,
  sesAccount: true,
  provider: null,
  name: "Symbol Soup",
  named: true,
  notifyTo: 0,
  notifyFailed: false,
  onList: 0,
  wrote: false,
  firstSend: null,
  subscribeUrl: "https://news.example.com/subscribe",
  ...over,
});

const sending = (
  state: "unproven" | "working" | "refusing",
  by: "test" | "confirmation" = "test",
): ProviderStatusView["sending"] => ({
  state,
  since: 1,
  last_accepted: state === "working" ? { at: 1, by } : null,
  refusal:
    state === "refusing"
      ? {
          cause: "configuration",
          found_by: "account_check",
          error: "SES has no configuration set by that name.",
          advice: "Fix the secret.",
          at: 1,
        }
      : null,
});

const ses = (over: Partial<ProviderStatusView> = {}) =>
  providerStatus({ state: "sandbox", unknown_reason: null, ...over });

const firstSend = (over: Partial<SendView> = {}): SendView =>
  sendView(
    sendSummary({
      id: "x1",
      post_id: "p1",
      subject: "The integral sign",
      status: "scheduled",
      fire_at: Date.now() + 86_400_000,
    }),
    over,
  );

/** Each step as `title: state (hint)`, so a phase reads as one list. */
const read = (steps: SetupStep[]) =>
  steps.map((s) => `${s.title}: ${s.state}${s.hint ? ` (${s.hint})` : ""}`);

describe("setup steps", () => {
  it("not connected: connecting is the step, and every step that sends waits for it (SPEC §13)", () => {
    expect(
      read(
        setupSteps(
          facts({ notConnected: true, sesAccount: false, named: false, name: "Newsletter" }),
        ),
      ),
    ).toEqual([
      "Connect Amazon SES: todo (Nothing can be sent, and signups stay closed, until SES is connected.)",
      "Send a test email: blocked (After Connect Amazon SES)",
      "Name your publication: todo (Currently “Newsletter”.)",
      "Get notified: todo (Kestrel emails you when a send finishes or needs you.)",
      "Request production access: todo (Name your publication first: AWS’s reviewer looks at it.)",
      "Bring your existing list: todo (Optional.)",
      "Write your first post: todo",
      "Schedule your first post: blocked (After Connect Amazon SES)",
      "Send a test email for your first post: blocked (After Schedule your first post)",
      "Share your subscribe link: blocked (After Send a test email)",
    ]);
  });

  it("not proven yet: a test email is the step, and scheduling isn't blocked", () => {
    const provider = ses({ sending: sending("unproven"), signups: "not_open" });
    expect(read(setupSteps(facts({ provider })))).toEqual([
      "Connect Amazon SES: done",
      "Send a test email: todo (SES is connected but hasn’t sent anything yet. Send one to an address verified in SES.)",
      "Name your publication: done",
      "Get notified: todo (Kestrel emails you when a send finishes or needs you.)",
      "Request production access: todo",
      "Bring your existing list: todo (Optional.)",
      "Write your first post: todo",
      "Schedule your first post: todo (Best after AWS grants access: until then it reaches only verified addresses.)",
      "Send a test email for your first post: blocked (After Schedule your first post)",
      "Share your subscribe link: blocked (After Send a test email)",
    ]);
  });

  it("refusing: the test step points at the health block, which states the problem", () => {
    const provider = ses({ sending: sending("refusing"), signups: "paused" });
    const steps = setupSteps(facts({ provider }));
    expect(read(steps.filter((s) => s.key === "test" || s.key === "share"))).toEqual([
      "Send a test email: attention (SES is refusing. The fix is above.)",
      "Share your subscribe link: blocked (After Send a test email)",
    ]);
    // Nothing on the steps restates SES's words or its fix.
    expect(steps.some((s) => s.hint?.includes("configuration set"))).toBe(false);
  });

  it("working in the sandbox: production access waits on AWS, and schedule and share say to wait, unblocked", () => {
    const provider = ses({ review: "pending", sending: sending("working"), signups: "open" });
    expect(read(setupSteps(facts({ provider, notifyTo: 2 })))).toEqual([
      "Connect Amazon SES: done",
      "Send a test email: done",
      "Name your publication: done",
      "Get notified: done",
      "Request production access: waiting (Waiting for AWS to grant production access.)",
      "Bring your existing list: todo (Optional.)",
      "Write your first post: todo",
      "Schedule your first post: todo (Best after AWS grants access: until then it reaches only verified addresses.)",
      "Send a test email for your first post: blocked (After Schedule your first post)",
      "Share your subscribe link: todo (Share it once AWS grants production access.)",
    ]);
  });

  it("working with production access, the first post scheduled: its frozen email's test is the step", () => {
    const provider = ses({
      state: "production",
      review: "granted",
      sending: sending("working", "confirmation"),
    });
    const s = firstSend();
    expect(
      read(setupSteps(facts({ provider, notifyTo: 1, onList: 40, wrote: true, firstSend: s }))),
    ).toEqual([
      "Connect Amazon SES: done",
      "Send a test email: done",
      "Name your publication: done",
      "Get notified: done",
      "Request production access: done",
      "Bring your existing list: done",
      "Write your first post: done",
      "Schedule your first post: done",
      `Send a test email for your first post: todo (“The integral sign” goes out ${fmt(s.fire_at)}. Send yourself a test of it first.)`,
      "Share your subscribe link: todo",
    ]);
  });

  it("ticks the first post's test from the scheduled send's tested_at, until a re-make makes the email new", () => {
    const at = Date.now();
    const state = (s: SendView) =>
      setupSteps(facts({ firstSend: s })).find((x) => x.key === "post_test")?.state;
    expect(state(firstSend({ tested_at: null }))).toBe("todo");
    expect(state(firstSend({ tested_at: at }))).toBe("done");
    expect(state(firstSend({ tested_at: at, remade_at: at + 1 }))).toBe("todo");
    expect(state(firstSend({ tested_at: at + 2, remade_at: at + 1 }))).toBe("done");
  });

  it("says where AWS's review stands, never that it denied, and what it can't tell", () => {
    const hint = (provider: ProviderStatusView | null, named = true) =>
      setupSteps(facts({ provider, named })).find((s) => s.key === "access")?.hint;
    expect(hint(ses({ review: "denied", review_case: "123" }))).toBe(
      "AWS hasn’t granted it yet. It has replied in AWS Support, case 123: answer there.",
    );
    expect(hint(ses({ review: "failed" }))).toBe("AWS didn’t receive your request. Ask again.");
    expect(hint(ses(), false)).toBe("Name your publication first: AWS’s reviewer looks at it.");
    expect(hint(providerStatus({ unknown_reason: "permission" }))).toBe(
      "Kestrel can’t read your SES account, so the SES console’s account dashboard says whether AWS granted it.",
    );
    // A review under way is a wait, never a block, named or not.
    const access = setupSteps(facts({ provider: ses({ review: "pending" }), named: false })).find(
      (s) => s.key === "access",
    );
    expect(access?.state).toBe("waiting");
  });

  it("leaves production access out where there's no SES account, and points at Settings when notifications fail", () => {
    const steps = setupSteps(facts({ sesAccount: false, notifyTo: 1, notifyFailed: true }));
    expect(steps.some((s) => s.key === "access")).toBe(false);
    expect(read(steps.filter((s) => s.key === "notify"))).toEqual([
      "Get notified: attention (The last notification didn’t arrive. Settings says why.)",
    ]);
  });
});

describe("setup card", () => {
  beforeEach(() => resetShell());
  const render = (f: SetupFacts, layout: "checklist" | "card" = "card") => {
    const el = document.createElement("div");
    setHtml(el, html`${setupStepsHtml(f, layout)}`);
    return el;
  };
  const fold = (el: HTMLElement) => el.querySelector(".setup-fold")?.textContent;
  const titles = (el: HTMLElement) =>
    [...el.querySelectorAll(".setup-steps li strong")].map((s) => s.textContent);

  it("folds finished steps into one line, naming each while there are few, and lists only what's left", () => {
    const provider = ses({ review: "pending", sending: sending("working"), signups: "open" });
    const el = render(facts({ provider, notifyTo: 2 }));
    expect(fold(el)).toBe(
      "✓4 done: Amazon SES connected, a test email sent, named Symbol Soup, notifications to 2 addresses",
    );
    expect(titles(el)).toEqual([
      "Request production access",
      "Bring your existing list",
      "Write your first post",
      "Schedule your first post",
      "Send a test email for your first post",
      "Share your subscribe link",
    ]);
    // The step to take now: the first one the publisher can take, past the one AWS has.
    expect(el.querySelector(".setup-current strong")?.textContent).toBe("Bring your existing list");
  });

  it("counts many finished steps and names the latest two", () => {
    const provider = ses({ state: "production", sending: sending("working") });
    const el = render(
      facts({ provider, notifyTo: 1, onList: 3, wrote: true, firstSend: firstSend() }),
    );
    expect(fold(el)).toBe(
      "✓8 done, including your first post written and your first post scheduled",
    );
    expect(titles(el)).toEqual([
      "Send a test email for your first post",
      "Share your subscribe link",
    ]);
    expect(el.querySelector<HTMLElement>(".setup-post-test button")?.dataset.nav).toBe("#/edit/p1");
    expect(el.querySelector<HTMLElement>(".setup-share button")?.dataset.copy).toBe(
      "https://news.example.com/subscribe",
    );
    expect(el.querySelector(".setup-url")?.textContent).toBe("https://news.example.com/subscribe");
  });

  it("says a blocked step's wait in plain text, with no link and no control", () => {
    const el = render(facts({ notConnected: true, sesAccount: false, named: false }));
    expect(el.querySelector(".setup-fold")).toBeNull();
    const blocked = [...el.querySelectorAll<HTMLElement>(".setup-blocked")];
    expect(blocked.map((li) => li.querySelector(".setup-hint")?.textContent)).toEqual([
      "After Connect Amazon SES",
      "After Connect Amazon SES",
      "After Schedule your first post",
      "After Send a test email",
    ]);
    for (const li of blocked) {
      expect(li.querySelector("a, button")).toBeNull();
    }
    // Sharing waits for signups: no address to copy yet.
    expect(el.querySelector(".setup-url")).toBeNull();
  });

  it("makes the step to take now the Primary on the checklist only, where the head has no New post", () => {
    const f = facts({ notConnected: true, sesAccount: false });
    expect(render(f, "checklist").querySelector("button.primary")?.textContent).toBe("Connect");
    expect(render(f, "card").querySelector("button.primary")).toBeNull();
  });
});
