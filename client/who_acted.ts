// Who acted, in the editor's words (SPEC §11, docs/DESIGN.md): a person in the editor reads as
// the person alone, a person through another client reads with the client, and a service token
// reads as one, since a service token is automation: Claude signs in as the person it works for.

import { CLAUDE_CODE_CLIENT, EDITOR_CLIENT } from "../shared/who_acted";

// Clients the editor knows by a name of their own. Any other reads as it named itself.
const CLIENT_NAMES: Record<string, string> = {
  [CLAUDE_CODE_CLIENT]: "Claude Code",
};

/**
 * Who made a change, as the editor shows it: `who` is a person's email or `service`, and
 * `client` the client a person came through, null when it named none. Null when nobody is
 * recorded.
 */
export function whoActed(who: string | null, client: string | null): string | null {
  if (!who) {
    return null;
  }
  if (who === "service") {
    return "a service token";
  }
  if (client === EDITOR_CLIENT) {
    return who;
  }
  if (client === null) {
    return `${who} via the API`;
  }
  return `${who} via ${CLIENT_NAMES[client] ?? client}`;
}
