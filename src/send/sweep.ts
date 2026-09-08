/**
 * The reconciling send sweep — runs once a minute from `scheduled()`.
 *
 * Real behavior lands in M6 (issue #7): fire due Sends, resume interrupted ones,
 * and loudly flag missed fire times. For now it's a no-op so the cron wiring is
 * real and exercisable.
 */
import type { AppEnv } from "../env";

export async function sweep(_env: AppEnv): Promise<void> {
  // no-op until M6
}
