/** Provider factory: pick the transport adapter from Config. */
import type { AppEnv, Config } from "../env";
import type { EmailProvider } from "./types";
import { FakeProvider } from "./fake";
import { SesProvider } from "./ses";
import { ResendProvider } from "./resend";

export function getProvider(config: Config, env: AppEnv): EmailProvider {
  switch (config.provider) {
    case "fake":
      return new FakeProvider();
    case "ses":
      return new SesProvider(config, env);
    case "resend":
      return new ResendProvider(config, env);
    default:
      return new FakeProvider();
  }
}
