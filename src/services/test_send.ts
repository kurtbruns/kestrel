/**
 * A test send's hand-off to the provider (SPEC §5): each address's answer, and for one not
 * sent, why, in words a publisher can act on. A test is the first thing a new operator
 * sends, often in a provider's sandbox, so a refusal names its cause and fix rather than
 * inviting a retry that can't work, and a request the provider never answered is said as
 * one that may have arrived, never as the server's fault.
 */

import type { TestNotSent } from "../../shared/posts";
import { refusalAdvice, sentence } from "../../shared/sends";
import { log } from "../lib/log";
import { perRecipient } from "../providers";
import type {
  BatchHalt,
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
} from "../providers/types";

/** One address's answer to a test: sent, or not, with why. */
export type TestAnswer =
  | { email: string; sent: true }
  | { email: string; sent: false; notSent: TestNotSent };

/** Which test this is, for its log line. */
export interface TestKind {
  test: "post" | "template";
  postId?: string;
}

/**
 * Hand a test to the provider and answer for each recipient, in order. A request that gets
 * no answer at all is every recipient's, possibly arrived, never a thrown error: the
 * provider's silence isn't the server failing.
 */
export async function sendTest(
  provider: EmailProvider,
  email: RenderedEmail,
  recipients: Recipient[],
  opts: SendBatchOptions,
  kind: TestKind,
): Promise<TestAnswer[]> {
  let answer: SendBatchResult;
  try {
    answer = await provider.sendBatch(email, recipients, opts);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const notSent = noAnswer(error);
    logNotSent(provider, kind, recipients.length, notSent);
    return recipients.map((r) => ({ email: r.email, sent: false, notSent }));
  }
  const halt = answer.halt;
  const unknown: TestNotSent[] = [];
  const refused: TestNotSent[] = [];
  const answers = perRecipient(answer, recipients).map((r): TestAnswer => {
    if (r.accepted) {
      return { email: r.email, sent: true };
    }
    // A halted request speaks for every recipient in it; an answered one only for those
    // it held back.
    const covering = answer.kind === "halted" || r.held ? halt : undefined;
    const notSent = why(r, covering);
    if (notSent.may_have_arrived) {
      unknown.push(notSent);
    } else if (covering || !r.retryable) {
      // A recipient never tried (after an earlier request got no answer) was refused by no
      // one, so only the line about that request explains it.
      refused.push(notSent);
    }
    return { email: r.email, sent: false, notSent };
  });
  if (unknown[0]) {
    logNotSent(provider, kind, unknown.length, unknown[0]);
  }
  if (refused[0]) {
    logNotSent(provider, kind, refused.length, refused[0]);
  }
  return answers;
}

function noAnswer(error: string): TestNotSent {
  return {
    may_have_arrived: true,
    error,
    message: `The provider didn’t answer, so the test may have arrived: ${sentence(error)} Check the inbox before sending it again.`,
  };
}

/** Why one recipient wasn't sent, from its result and the halt that covers it, if any. */
function why(
  r: Extract<PerRecipientResult, { accepted: false }>,
  halt: BatchHalt | undefined,
): TestNotSent {
  if (r.unknown) {
    return noAnswer(r.error);
  }
  const error = halt?.error ?? r.error;
  const refused = (message: string): TestNotSent => ({ may_have_arrived: false, error, message });
  if (halt?.reason === "account") {
    return refused(
      `The provider refused it: ${sentence(error)} ${refusalAdvice(halt.cause)} Sending the test again gets the same answer until that is fixed.`,
    );
  }
  if (halt) {
    return refused(
      `The provider can’t take mail right now: ${sentence(error)} Send the test again in a few minutes.`,
    );
  }
  if (r.retryable) {
    return refused(`It wasn’t sent: ${sentence(error)} Send the test again to try it.`);
  }
  return refused(
    `The provider refused it: ${sentence(error)} Sending to this address again gets the same answer until what the provider names is fixed.`,
  );
}

/** One line for the test's unsent addresses of one kind: counted, with the first one's
 *  words, and never an address (SPEC §12). */
function logNotSent(
  provider: EmailProvider,
  kind: TestKind,
  count: number,
  first: TestNotSent,
): void {
  log.warn(first.may_have_arrived ? "test.unknown" : "test.refused", {
    provider: provider.name,
    test: kind.test,
    postId: kind.postId,
    count,
    error: first.error,
  });
}
