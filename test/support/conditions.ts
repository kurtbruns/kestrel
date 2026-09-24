/**
 * Reading a send's conditions in a spec: whether one of a kind is open, and the one itself.
 */
import type { ConditionKind, SendCondition } from "../../shared/sends";

type WithConditions = { conditions: SendCondition[] } | null | undefined;

/** Whether the send has an open condition of `kind`. */
export const has = (s: WithConditions, kind: ConditionKind): boolean =>
  s?.conditions.some((c) => c.kind === kind) ?? false;

/** The send's open condition of `kind`, if any. */
export function condition<K extends ConditionKind>(
  s: WithConditions,
  kind: K,
): Extract<SendCondition, { kind: K }> | undefined {
  return s?.conditions.find((c) => c.kind === kind) as
    | Extract<SendCondition, { kind: K }>
    | undefined;
}
