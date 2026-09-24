/**
 * A send as a refusal or an action hands it back: its `GET /sends` row, with the phase,
 * conditions, and actions read now, so a client refused (or answered) learns where the send
 * stands without a second read.
 */

import type { SendListItem, SendSummary } from "../../shared/sends";
import { hasActiveRetries } from "../db/sends";
import { buildListItem } from "./progress";

/** The send as it stands, in the `GET /sends` row shape. The frozen bodies are left out. */
export async function describeSend(db: D1Database, send: SendSummary): Promise<SendListItem> {
  const {
    rendered_html: _html,
    rendered_text: _text,
    ...summary
  } = send as SendSummary & {
    rendered_html?: string;
    rendered_text?: string;
  };
  const retries = summary.status === "sending" ? await hasActiveRetries(db, summary.id) : false;
  return buildListItem(summary, retries, Date.now());
}
