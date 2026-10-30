/**
 * The email provider's connection (authed admin, SPEC §13).
 *
 *   GET /api/provider → where the connection stands, what the provider's account last said
 *                       about itself, any warning, in the server's words, whether email is
 *                       getting out, and whether the public form takes signups
 *
 * Read-only, and it never asks the provider: it reads what the sweep's account check last
 * kept (`services/provider_status.ts`) and what the provider last answered an email
 * (`services/sending.ts`), so a page load costs two queries however often it comes.
 */

import type { ProviderStatusView } from "../../shared/provider";
import { readProviderAccount } from "../db/provider_account";
import { readSending } from "../db/sending";
import { json } from "../lib/errors";
import type { RequestContext } from "../router";
import { providerStatusView } from "../services/provider_status";

export async function get(c: RequestContext): Promise<Response> {
  const [row, sending] = await Promise.all([
    c.config.provider === "ses" ? readProviderAccount(c.env.DB) : null,
    c.config.provider === "none" ? null : readSending(c.env.DB),
  ]);
  const body: ProviderStatusView = providerStatusView(c.config, row, sending);
  return json(body);
}
