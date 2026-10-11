/**
 * Providers with no idempotency key, built on `ResendLikeProvider` so they mail and count
 * the same way: a request whose answer is lost can't be re-sent safely, so the loop leaves
 * its recipients in flight for Resolve (SPEC §12). One copy, so the send specs that switch
 * to one mid-send all switch to the same thing.
 */
import { ResendLikeProvider } from "./resend_like";

/** Resend's batches with no key behind them. */
export class NoKeyProvider extends ResendLikeProvider {
  override readonly idempotentRetry: boolean = false;
  override readonly idempotencyWindowMs: number | undefined = undefined;
}

/** SES-shaped: one recipient a request and no idempotency key. */
export class SesLikeProvider extends NoKeyProvider {
  override readonly maxBatch: number = 1;
}
