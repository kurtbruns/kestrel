/**
 * Who a send reaches (SPEC §7, I1, I2): exactly the confirmed subscribers whose address is
 * not suppressed. The send fixes its audience with `resolveAudience`; the estimate a
 * scheduled send shows (`audienceCount`) and the listing the dev seed reads
 * (`audienceEmails`) must say the same, over a list holding every kind the rule leaves out.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as subs from "../src/db/subscribers";
import { resetDatabase, seedConfirmed, sendAudience } from "./support/fixtures";

/** One address of every kind the audience rule meets, and the two it lets in. */
async function listOfEveryKind(): Promise<void> {
  await seedConfirmed([
    "confirmed@example.com",
    "lifted@example.com",
    "bounced@example.com",
    "blocked@example.com",
    "left@example.com",
    "complained@example.com",
    "erased@example.com",
  ]);
  await subs.ensureSubscriber(env.DB, "pending@example.com");
  await subs.ensureSubscriber(env.DB, "pending-blocked@example.com");

  await subs.addSuppression(env.DB, "bounced@example.com", "bounce");
  await subs.block(env.DB, "blocked@example.com");
  await subs.block(env.DB, "pending-blocked@example.com");
  await subs.addSuppression(env.DB, "no-subscriber@example.com", "bounce");
  await subs.addSuppression(env.DB, "lifted@example.com", "bounce");
  await subs.liftSuppression(env.DB, "lifted@example.com", "bounce");

  await subs.unsubscribeById(env.DB, "id-left@example.com");
  await subs.complain(env.DB, "complained@example.com");
  expect((await subs.erase(env.DB, "id-erased@example.com")).kind).toBe("erased");
}

describe("the audience (SPEC §7, I1, I2)", () => {
  beforeEach(resetDatabase);

  it("a send reaches only the confirmed subscribers whose address is not suppressed", async () => {
    await listOfEveryKind();
    expect(await sendAudience()).toEqual(["confirmed@example.com", "lifted@example.com"]);
  });

  it("the estimate and the listing count and name the same people the send reaches", async () => {
    await listOfEveryKind();
    const reached = await sendAudience();
    expect(await subs.audienceEmails(env.DB)).toEqual(reached);
    expect(await subs.audienceCount(env.DB)).toBe(reached.length);
  });

  it("an empty list reaches no one, and all three readings say so", async () => {
    expect(await sendAudience()).toEqual([]);
    expect(await subs.audienceEmails(env.DB)).toEqual([]);
    expect(await subs.audienceCount(env.DB)).toBe(0);
  });
});
