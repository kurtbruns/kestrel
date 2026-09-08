/** Provider factory: pick the transport adapter from Config. */
import type { AppEnv, Config } from "../env";
import type { EmailProvider } from "./types";
import { FakeProvider } from "./fake";

export function getProvider(config: Config, _env: AppEnv): EmailProvider {
  switch (config.provider) {
    case "fake":
      return new FakeProvider();
    case "ses":
      throw new Error("SES adapter is not implemented yet (M9)");
    case "resend":
      throw new Error("Resend adapter is not implemented yet (M10)");
    default:
      return new FakeProvider();
  }
}
