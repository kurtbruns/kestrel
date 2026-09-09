/** Provider factory: pick the transport adapter from Config. */
import type { AppEnv, Config } from "../env";
import type { EmailProvider } from "./types";
import { FakeProvider } from "./fake";
import { SesProvider } from "./ses";

export function getProvider(config: Config, env: AppEnv): EmailProvider {
  switch (config.provider) {
    case "fake":
      return new FakeProvider();
    case "ses":
      return new SesProvider(config, env);
    case "resend":
      throw new Error("Resend adapter is not implemented yet (M10)");
    default:
      return new FakeProvider();
  }
}
