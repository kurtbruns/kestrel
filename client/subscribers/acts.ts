// The acts on one subscriber, offered alike by their roster row's menu and their own page:
// which apply to them as they stand, each opening its dialog.

import { SUBSCRIBER_ACTIONS, SUPPRESSION_FLAG } from "../../shared/subscriber_meanings";
import type { Subscriber } from "../../shared/subscribers";
import type { MenuItem } from "../ui/widgets";
import {
  confirmBlock,
  confirmClear,
  confirmErase,
  confirmUnblock,
  confirmUnsubscribe,
} from "./dialogs";
import { isErased } from "./labels";

/**
 * The acts that apply to `sub` (SPEC §7), in the order they are offered: a pending or
 * confirmed subscriber can be unsubscribed. An address with no suppression can be blocked; a
 * block is undone by Unblock, and a bounce by Clear, the weightier act. Anyone not already
 * erased can be erased. `onDone` runs after an act lands.
 */
export function subscriberActs(
  sub: Subscriber,
  onDone: () => void,
  signal: AbortSignal,
): MenuItem[] {
  const items: MenuItem[] = [];
  if (sub.status !== "unsubscribed") {
    items.push({
      label: SUBSCRIBER_ACTIONS.unsubscribe.label,
      danger: true,
      onClick: () => confirmUnsubscribe(sub, onDone, signal),
    });
  }
  if (!sub.suppression) {
    items.push({
      label: SUBSCRIBER_ACTIONS.block.label,
      danger: true,
      onClick: () => confirmBlock(sub, onDone, signal),
    });
  } else if (sub.suppression.reason === "manual") {
    items.push({
      label: SUBSCRIBER_ACTIONS.unblock.label,
      onClick: () => confirmUnblock(sub, onDone, signal),
    });
  } else if (SUPPRESSION_FLAG[sub.suppression.reason] === "bounced") {
    items.push({
      label: SUBSCRIBER_ACTIONS.clear.label,
      danger: true,
      onClick: () => confirmClear(sub, onDone, signal),
    });
  }
  if (!isErased(sub)) {
    items.push({
      label: SUBSCRIBER_ACTIONS.erase.label,
      danger: true,
      onClick: () => confirmErase(sub, onDone, signal),
    });
  }
  return items;
}
