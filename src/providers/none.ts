/**
 * The transport of a deployment with no provider connected (SPEC §9): it carries nothing.
 * The routes that would send refuse before they reach it (`requireConnectedProvider`), so
 * what reaches this adapter is a send scheduled before the provider was disconnected, or a
 * notification through the provider channel. It answers each batch the way a provider
 * refusing the account does (SPEC §12): a halt that proves nothing was taken, so the send
 * keeps its place, consumes no one, and resumes once a provider is connected (I4). Its
 * webhook answers 404, since no provider is there to call it.
 */
import type {
  EmailProvider,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "./types";

/** What a halt and a failed notification say: the fact alone. The fix is the
 *  `not_connected` cause's advice, said once beside it (`refusalAdvice`). */
export const NOT_CONNECTED_ERROR = "No email provider is connected to this deployment.";

export class NotConnectedProvider implements EmailProvider {
  readonly name = "none" as const;
  // Traits the send loop reads before its first batch; nothing is ever carried, so they
  // only need to be valid.
  readonly maxBatch = 100;

  async sendBatch(
    _rendered: RenderedEmail,
    _recipients: Recipient[],
    _opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    return {
      kind: "halted",
      halt: {
        reason: "account",
        cause: "not_connected",
        error: NOT_CONNECTED_ERROR,
      },
    };
  }

  async parseWebhook(): Promise<WebhookResult> {
    return {
      events: [],
      response: Response.json(
        { error: "not_found", message: "no email provider is connected" },
        { status: 404 },
      ),
    };
  }
}
