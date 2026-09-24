/** Provider factory: pick the transport adapter from Config. */
import type { AppEnv, Config } from "../env";
import { FakeProvider } from "./fake";
import { ResendProvider } from "./resend";
import { SesProvider } from "./ses";
import { SimProvider } from "./simulate";
import type { EmailProvider, PerRecipientResult, Recipient, SendBatchResult } from "./types";

export function getProvider(config: Config, env: AppEnv): EmailProvider {
  switch (config.provider) {
    case "fake":
      // Local dev: the send simulation stands in for a real provider on list sends (SPEC
      // §10). `simulation` is only ever set in a dev-shaped env (getConfig), so a deployed
      // env never reaches it.
      return config.simulation ? new SimProvider(config.simulation) : new FakeProvider();
    case "ses":
      return new SesProvider(config, env);
    case "resend":
      return new ResendProvider(config, env);
    default: {
      // getConfig admits only known names, so this is unreachable; the `never` makes a new
      // name a compile error here, and the throw keeps it from ever falling through to a
      // transport that would record every recipient accepted and mail no one.
      const unknown: never = config.provider;
      throw new Error(`no transport for provider "${String(unknown)}"`);
    }
  }
}

/**
 * A batch answer as one result per recipient, for the one-off callers (test sends,
 * confirmations) that report a recipient's fate and have no send to hold open. A halt
 * becomes the same failure for everyone in the batch; only the send loop acts on it.
 */
export function perRecipient(
  result: SendBatchResult,
  recipients: Recipient[],
): PerRecipientResult[] {
  if (result.kind === "answered") {
    return result.results;
  }
  const { reason, error } = result.halt;
  return recipients.map((r) => ({
    email: r.email,
    accepted: false as const,
    retryable: reason === "unavailable",
    error,
  }));
}
