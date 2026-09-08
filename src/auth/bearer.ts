/** Bearer-token auth: constant-time compare of `Authorization: Bearer` vs a secret. */
import type { AppEnv } from "../env";
import type { Principal } from "../router";
import { timingSafeEqual } from "../lib/constant_time";

export async function checkBearer(req: Request, env: AppEnv): Promise<Principal | null> {
  const header = req.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const expected = env.BEARER_TOKEN;
  if (!expected) return null;
  const token = header.slice("Bearer ".length);
  if (!(await timingSafeEqual(token, expected))) return null;
  // The bearer path is the non-interactive principal (Claude / CI).
  return { kind: "service" };
}
