/**
 * A send's view built straight from a row, for specs of the pure derivation: the same
 * `buildSendView` every route uses, with a fixed provider name and no archive.
 */
import type { SendSummary, SendView } from "../../shared/sends";
import { DEFAULT_SUBREQUEST_BUDGET, type ProviderName } from "../../src/env";
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
    { ...row, post_slug: null },
    {
      provider,
      archiveOrigin: base,
      archiveBasePath: "/",
      subrequestBudget: DEFAULT_SUBREQUEST_BUDGET,
    },
    hasRetries,
    now,
  );
}
