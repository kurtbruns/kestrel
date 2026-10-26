/**
 * The email provider's connection (authed admin, SPEC §9).
 *
 *   GET /api/provider → where the connection stands, what the provider's account last said
 *                       about itself, and any warning, in the server's words
 *
 * Read-only, and it never asks the provider: it reads what the sweep's account check last
 * kept (`services/provider_status.ts`), so a page load costs one query however often it comes.
 */

import type { ProviderStatusView } from "../../shared/provider";
import { readProviderAccount } from "../db/provider_account";
import { json } from "../lib/errors";
import type { RequestContext } from "../router";
import { providerStatusView } from "../services/provider_status";

export async function get(c: RequestContext): Promise<Response> {
  const row = c.config.provider === "ses" ? await readProviderAccount(c.env.DB) : null;
  const body: ProviderStatusView = providerStatusView(c.config, row);
  return json(body);
}
