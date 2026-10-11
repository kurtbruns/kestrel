/**
 * Fixtures the send-surface specs share: a send's row put in a state by hand, and an email
 * template a spec can tell apart from another, so a re-made send's email shows which it had.
 */

import { env } from "cloudflare:workers";

/** Put a send's row in the given state, the way the send loop would have left it. It takes
 *  no `rev`, so what it sets is something the clock, not a write, has to surface. */
export async function setRow(
  id: string,
  fields: Record<string, number | string | null>,
): Promise<void> {
  const cols = Object.keys(fields);
  await env.DB.prepare(`UPDATE sends SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => fields[c] ?? null), id)
    .run();
}

/** A minimal valid email template that carries `marker`, so two saves differ. */
export const tpl = (marker: string): string =>
  `<div>{{ .Post.Body }}<p>${marker} · {{ .Publication.Name }}</p><a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></div>`;
