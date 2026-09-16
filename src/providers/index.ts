/** Provider factory: pick the transport adapter from Config. */
import type { AppEnv, Config } from "../env";
import { FakeProvider } from "./fake";
import { ResendProvider } from "./resend";
import { SesProvider } from "./ses";
import { SimProvider } from "./simulate";
import type { EmailProvider } from "./types";

export function getProvider(config: Config, env: AppEnv): EmailProvider {
  switch (config.provider) {
    case "fake":
      // Dev-only opt-in: the seeded send simulation stands in for the plain fake so an
      // in-flight send is watchable (SPEC §9). `simulateSends` is only ever true in a
      // dev-shaped env (getConfig), so a deployed env never reaches this branch.
      return config.simulateSends ? new SimProvider() : new FakeProvider();
    case "ses":
      return new SesProvider(config, env);
    case "resend":
      return new ResendProvider(config, env);
    default:
      return new FakeProvider();
  }
}
