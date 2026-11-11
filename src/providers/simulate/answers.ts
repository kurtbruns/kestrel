/**
 * The error responses the simulated SES answers with in place of taking an email (SPEC §10):
 * the developer's one answer (`SimulatedAnswer`: a refusal of the account, an outage, or a
 * refusal of a send's own email) and the sandbox's refusal of a recipient it doesn't mail. Each
 * is SES's own error response, handed to the real adapter's classifier (`classifySesError`,
 * `sesBulkError`), so the app reaches what follows (email refusing, a paused signup, a held
 * send, SPEC §12, §13) by its own path; nothing here decides what a response means.
 */

import type { RefusingCause } from "../../../shared/provider";
import type { SimulatedAnswer, SimulatedSendRefusal } from "../../../shared/settings";
import type { Config } from "../../env";
import { bareAddress, classifySesError, sesErrorText } from "../ses";
import type { BatchHalt, Recipient } from "../types";
import { simulatedAccountRow } from "./account";
import { adapterHalt } from "./profiles";

/** An SES error response, as the adapter reads one. */
export interface SesErrorResponse {
  status: number;
  type: string;
  msg: string;
}

/** The error response SES answers each simulated refusal of the account with, as the real account would. */
function refusalResponse(cause: RefusingCause, config: Config): SesErrorResponse {
  switch (cause) {
    case "credentials":
      return {
        status: 403,
        type: "UnrecognizedClientException",
        msg: "The security token included in the request is invalid. (simulated)",
      };
    case "opt_in":
      return {
        status: 403,
        type: "OptInRequired",
        msg: "The AWS Access Key Id needs a subscription for the service. (simulated)",
      };
    case "configuration":
      return {
        status: 404,
        type: "NotFoundException",
        msg: `Configuration set <${config.sesConfigurationSet ?? "kestrel-mail"}> does not exist. (simulated)`,
      };
    case "sender":
      return {
        status: 400,
        type: "MessageRejected",
        msg: `Email address is not verified. The following identities failed the check in region ${config.awsRegion.toUpperCase()}: ${bareAddress(config.fromAddress)}`,
      };
    case "mail_from":
      return {
        status: 400,
        type: "MailFromDomainNotVerifiedException",
        msg: "The MAIL FROM domain's MX record can't be read. (simulated)",
      };
    case "paused":
      return {
        status: 400,
        type: "SendingPausedException",
        msg: "Sending is paused for this account. (simulated)",
      };
    case "set_paused":
      return {
        status: 400,
        type: "SendingPausedException",
        msg: "Sending is paused for this configuration set. (simulated)",
      };
    case "suspended":
      return {
        status: 400,
        type: "AccountSuspendedException",
        msg: "The account's ability to send email has been permanently restricted. (simulated)",
      };
    default:
      return { status: 404, type: "UnknownOperationException", msg: "(simulated)" };
  }
}

/**
 * The error response SES answers every request with while the simulated provider is down
 * (`SIMULATE_SENDS=ses:outage`): a request SES never received whole. Not a 5xx, which may
 * follow a request SES accepted (`sesFateUnknown`), so a list send would strand the batch for
 * Resolve rather than wait out the outage; this is the answer that tells the app the provider
 * took nothing and is unavailable, which is the outage to watch.
 */
const SES_OUTAGE: SesErrorResponse = {
  status: 408,
  type: "RequestTimeoutException",
  msg: "Request timed out before SES received it whole. (simulated outage)",
};

/**
 * The error responses SES refuses a send's own email with (`SIMULATE_SENDS=ses:bad_request` or
 * `ses:rejected`), neither of them the account's, so no other send waits on it (SPEC §12):
 *   - `bad_request`: every list request refused as invalid, in words that name no one, so the
 *     adapter can't tell whether it is about one recipient or the request. A test goes through:
 *     the answer is about a send's requests, and how a one-off email meets it has never been
 *     reasoned about, so the simulation doesn't guess.
 *   - `rejected`: the message rejected for what it says, in words about neither the sender's
 *     identity nor a recipient's. Every post's email meets it, so a test of a post (the send's
 *     own email, I5) is refused too.
 * A confirmation and a notification are other emails, so they go through under either.
 */
export const SEND_REFUSALS: Record<SimulatedSendRefusal, SesErrorResponse & { tests: boolean }> = {
  bad_request: {
    status: 400,
    type: "BadRequestException",
    msg: "Invalid input. (simulated)",
    tests: false,
  },
  rejected: {
    status: 400,
    type: "MessageRejected",
    msg: "Message rejected: the message was refused for its content. (simulated)",
    tests: true,
  },
};

/** The halt the real adapter returns for an SES error response. */
export function sesHalt(r: SesErrorResponse, from: string): BatchHalt {
  return adapterHalt(
    classifySesError(r.status, r.type, r.msg, from),
    sesErrorText(r.status, r.type, r.msg),
  );
}

/**
 * The halt every email meets under the developer's answer, when it is the account's (a refusal
 * of the account, or an outage): a test, a confirmation, and the publisher's own notification
 * wait on it too, as they would on a real account. Null for no answer, or one that refuses only
 * a send's own email (`SEND_REFUSALS`).
 */
export function everyEmailHalt(answer: SimulatedAnswer | null, config: Config): BatchHalt | null {
  if (answer?.kind === "refuse") {
    return sesHalt(refusalResponse(answer.cause, config), config.fromAddress);
  }
  if (answer?.kind === "outage") {
    return sesHalt(SES_OUTAGE, config.fromAddress);
  }
  return null;
}

/** The domain of SES's mailbox simulator, whose addresses the sandbox lets through. */
const SES_SIMULATOR_DOMAIN = "simulator.amazonses.com";

/**
 * Whether a recipient is one the simulated sandbox mails: an address at the sending domain
 * (a verified domain identity covers every address at it, as in SES) or at SES's mailbox
 * simulator. Any other is one the developer hasn't verified.
 */
function sandboxVerified(email: string, config: Config): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return domain === config.sendingDomain.toLowerCase() || domain === SES_SIMULATOR_DOMAIN;
}

/** The refusal SES's sandbox gives a request naming recipients it doesn't mail, or null. */
export function sandboxRefusal(recipients: Recipient[], config: Config): BatchHalt | null {
  if (!config.simulation?.account) {
    return null;
  }
  const row = simulatedAccountRow(config.simulation.account, config, Date.now());
  if (row.answer?.productionAccess !== false) {
    return null;
  }
  const unverified = recipients.filter((r) => !sandboxVerified(r.email, config));
  if (unverified.length === 0) {
    return null;
  }
  return sesHalt(
    {
      status: 400,
      type: "MessageRejected",
      msg: `Email address is not verified. The following identities failed the check in region ${config.awsRegion.toUpperCase()}: ${unverified.map((r) => r.email).join(", ")}`,
    },
    config.fromAddress,
  );
}
