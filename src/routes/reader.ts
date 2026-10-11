/**
 * What every reader page needs from this instance before it can render (SPEC §5): the
 * publication identity, the public archive home, the dev-only dashboard shortcut, and
 * the message-page wrapper built from them. Shared by the archive routes and the
 * token-scoped subscribe, confirm, and unsubscribe routes, so each reader page resolves
 * them the same way.
 */

import { publicationName } from "../../shared/publication";
import { BRANDING_LOGO_KEY, getSettingsForDisplay } from "../db/settings";
import type { Config } from "../env";
import { type MessagePageOptions, messagePage, type ReaderIdentity } from "../lib/page";
import type { RequestContext } from "../router";

/** The resolved publication identity for a reader page: the operator's settings, with
 *  the name resolved as the email resolves it, so it is "" when neither the publisher
 *  nor the `From:` header names the publication (shape in `lib/page.ts`). A corrupt
 *  settings row reads as the defaults, so a reader page never fails on it. */
export async function readerIdentity(c: RequestContext, config: Config): Promise<ReaderIdentity> {
  const { publication: p } = await getSettingsForDisplay(c.env.DB);
  return {
    name: publicationName(p.name, config.fromAddress),
    tagline: p.tagline,
    logoUrl: p.logo ? `${config.mediaPublicBase}/${BRANDING_LOGO_KEY}?v=${p.logo.version}` : "",
  };
}

/** The full archive URL (origin + base path): the home of the post list and the target
 *  of every "Browse the archive" link. Built from the same config the route registers at. */
export function archiveHomeUrl(config: Config): string {
  return `${config.archiveOrigin}${config.archiveBasePath}`;
}

/** The dev-only "Open dashboard" target for the reader surface, or `undefined` when
 *  not a dev-shaped instance. Only local dev (no Access edge) surfaces this link, so
 *  a deployed public page never points at the Access-gated editor (SPEC §5, §11). */
export function devDashboardUrl(config: Config): string | undefined {
  return config.devMode ? `${config.appOrigin}/dashboard/` : undefined;
}

/** A message page (confirm, unsubscribe, not found) in this instance's reader shell:
 *  the publication identity, the public home link, and, in local dev only, the
 *  dashboard shortcut, around the page's own copy. A caller whose copy names the
 *  publication passes the identity it already read. */
export async function readerMessage(
  c: RequestContext,
  page: Omit<MessagePageOptions, "identity" | "homeUrl" | "devDashboardUrl">,
  identity?: ReaderIdentity,
): Promise<Response> {
  return messagePage({
    ...page,
    identity: identity ?? (await readerIdentity(c, c.config)),
    homeUrl: `${c.config.appOrigin}/`,
    devDashboardUrl: devDashboardUrl(c.config),
  });
}
