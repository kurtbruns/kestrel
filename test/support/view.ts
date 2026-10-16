/**
 * A send's view built straight from a row, for specs of the pure derivation: the same
 * `buildSendView` every route uses, with a fixed provider name and no archive.
 */
import { writesDay } from "../../shared/daily_writes";
import type { SendSummary, SendView } from "../../shared/sends";
import type { ProviderName } from "../../src/env";
import { buildSendView } from "../../src/send/view";
import { base } from "./http";

export function viewOf(
  send: SendSummary,
  provider: ProviderName,
  hasRetries: boolean,
  now: number,
): SendView {
  const {
    rendered_html: _h,
    rendered_text: _t,
    ...row
  } = send as SendSummary & {
    rendered_html?: string;
    rendered_text?: string;
  };
  return buildSendView(
    {
      ...row,
      web_link: "unlisted",
      post_slug: null,
      post_unlisted_token: null,
      post_email_only: 0,
    },
    {
      provider,
      appOrigin: base,
      archiveOrigin: base,
      archiveBasePath: "/",
    },
    hasRetries,
    now,
    // The default budget is Workers Free's limits, with no import yet that day.
    writesDay(now, 0),
  );
}
