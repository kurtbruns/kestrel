/**
 * The providers the local send simulation can model (`SIMULATE_SENDS`, SPEC §10), one profile
 * each: its traits, its pace, and the failures `realistic` injects. A profile reads its traits
 * and failure answers from the adapter it models and never restates them.
 *
 *   - `ses` takes its traits from the real adapter (`sesTraits`: a batch of one second of the
 *     account's send rate, up to 50, at one request a second, which the send loop paces to),
 *     and answers a failure the way the adapter answers it: the quota's halt comes from the
 *     adapter's own classifier and wording. Each request takes a request's time. The answers
 *     only SES gives (a refusal, an outage, the sandbox) are in `answers.ts`.
 *   - `generic` (also `1`) is a provider paced to be watched: a batch of eight, each taking
 *     most of a second, so a demo's progress fills visibly. It is the one profile whose
 *     provider refuses a few readers once with a retryable error and takes them on the retry,
 *     which SES never does, so the send loop's retry of a retryable reader can be seen
 *     locally. It has none of SES's account answers.
 */

import type { SimulationProfile } from "../../../shared/settings";
import type { Config } from "../../env";
import { unwrap } from "../../lib/unwrap";
import { classifySesError, sesEntryErrorText, sesErrorText, sesTraits } from "../ses";
import type { BatchHalt, ProviderTraits } from "../types";

/** How one simulated provider behaves: its traits, its pace, and its failures. */
export interface SimProfile {
  /** The provider's traits, as its adapter declares them for this deployment's config. */
  traits: (config: Config) => ProviderTraits;
  /** How long one request to the provider takes. */
  requestMs: number;
  /** Recipients refused once with a retryable error, accepted on the retry. */
  transientRate: number;
  /** Requests that leave and get no answer: the provider may have sent them (§12). */
  lostRate: number;
  /** Recipients the provider refuses for good at hand-off (rare: a bad address is
   *  accepted and bounces later). */
  rejectRate: number;
  rejectError: string;
  /** The account's sending quota running out, as the adapter reports it; null for a
   *  profile that doesn't model it. */
  quota: BatchHalt | null;
  /** Which edge states `realistic` guarantees once per send, so a demo shows them. The lost
   *  request is placed after the quota lifts, so it comes only with the quota. */
  guaranteed: { lost: boolean; quota: boolean };
}

/** An adapter's classification of an error response, with its wording: the halt the real
 *  adapter would return for that response. */
export function adapterHalt(classified: Omit<BatchHalt, "error"> | null, error: string): BatchHalt {
  return { ...unwrap(classified, "a halting error response"), error };
}

const SES_QUOTA = {
  status: 429,
  type: "TooManyRequestsException",
  msg: "Daily message quota exceeded.",
};

/**
 * Each profile is built when a simulation asks for it, never at module load: the send loop
 * and sweep import the simulation in every environment, so a profile that can't be built (an
 * adapter answer `adapterHalt` can't read) fails the dev server simulating that provider,
 * never a deployed Worker's startup.
 */
export const PROFILES: Record<SimulationProfile, () => SimProfile> = {
  generic: () => ({
    traits: () => ({ maxBatch: 8 }),
    requestMs: 900,
    transientRate: 0.04,
    lostRate: 0,
    rejectRate: 0.001,
    rejectError: "simulated permanent transport failure (550)",
    quota: null,
    guaranteed: { lost: false, quota: false },
  }),
  ses: () => ({
    // The send loop keeps requests to SES's one a second (`maxRequestRate`); this is how
    // long each bulk request takes to be answered.
    traits: sesTraits,
    requestMs: 250,
    transientRate: 0,
    lostRate: 0.0005,
    rejectRate: 0.001,
    // SES refuses one entry of a bulk request in that entry's own result.
    rejectError: sesEntryErrorText(
      "MESSAGE_REJECTED",
      "Email address is on the account's suppression list. (simulated)",
    ),
    quota: adapterHalt(
      classifySesError(SES_QUOTA.status, SES_QUOTA.type, SES_QUOTA.msg),
      sesErrorText(SES_QUOTA.status, SES_QUOTA.type, SES_QUOTA.msg),
    ),
    guaranteed: { lost: true, quota: true },
  }),
};
