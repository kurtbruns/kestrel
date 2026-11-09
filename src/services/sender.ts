/**
 * The sender an email goes out as (SPEC §9): the deploy-time address, and the display name
 * the rule in `shared/publication.ts` gives it from the publication's name. Every caller
 * that hands a provider an email resolves the sender here, so a confirmation, a test, a
 * notification, and a list send can't disagree on who the email is from: the rule as it
 * stands now for a one-off message, and a send's own frozen name for a list send, which
 * is what the publisher reviewed (I3, I5).
 */

import { fromAddressOnly, type Sender, sender } from "../../shared/publication";
import type { SendRow } from "../db/sends";
import { getSettings } from "../db/settings";
import type { Config } from "../env";

/** The sender as it stands now: the publication's name through the rule. */
export async function currentSender(db: D1Database, config: Config): Promise<Sender> {
  const { publication } = await getSettings(db);
  return sender(publication.name, config.fromAddress);
}

/**
 * The sender a send goes out as: the name frozen with its render, read from the row the
 * send loop already holds, so a run reads nothing more for it; or, for a send frozen
 * before the name was kept (null), the rule as it stands when it fires, since its
 * publisher never confirmed a frozen name and the name in use then is the one every
 * other surface shows.
 */
export async function sendSender(
  db: D1Database,
  config: Config,
  send: Pick<SendRow, "from_name">,
): Promise<Sender> {
  if (send.from_name === null) {
    return currentSender(db, config);
  }
  return { name: send.from_name, address: fromAddressOnly(config.fromAddress) };
}
