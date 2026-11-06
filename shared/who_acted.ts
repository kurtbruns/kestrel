// Who acted (SPEC §11): a person or a service token, plus the client the request came
// through, which names itself in one header. The Worker checks the name and records it; the
// editor sends its own and shows the others'. One definition, so the two can't disagree on
// what a well-formed name is.

/** The request header a client names itself in. */
export const CLIENT_HEADER = "Kestrel-Client";

/** The name the web editor sends on every call. */
export const EDITOR_CLIENT = "editor";

/** The name `kestrel api` sends when Claude Code runs it. */
export const CLAUDE_CODE_CLIENT = "claude-code";

/** The name `kestrel api` sends when anything else runs it: a person, or a script of theirs. */
export const KESTREL_CLI_CLIENT = "kestrel-cli";

/** The name the instance's MCP server, the connector, gives every call it makes. */
export const CLAUDE_CLIENT = "claude";

/**
 * Every name a client of Kestrel's own gives. The reference and the other copies of these names
 * are prose, so `test/reference.spec.ts` holds them to this list, and `packages/kestrel/`, which
 * imports nothing from here, is held to it by `test/cli/sign_in.spec.mjs`.
 */
export const KESTREL_CLIENTS = [
  EDITOR_CLIENT,
  CLAUDE_CODE_CLIENT,
  KESTREL_CLI_CLIENT,
  CLAUDE_CLIENT,
] as const;

/** The longest client name taken: a short word, never a sentence. */
export const CLIENT_NAME_MAX = 32;

/** A client name's form, as a regular expression's source: lowercase letters and digits,
 *  in parts joined by single hyphens. */
export const CLIENT_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

/**
 * Whether `value` is a well-formed client name: one short lowercase word, its parts joined by
 * single hyphens (`editor`, `claude-code`). A name the app doesn't know is still well formed.
 */
export function isClientName(value: string): boolean {
  return value.length <= CLIENT_NAME_MAX && new RegExp(CLIENT_NAME_PATTERN).test(value);
}

/**
 * Who acted (SPEC §11), as the API reports it wherever a change is recorded on one object: a
 * person by their email, or a service token by its name, plus the client a person came through.
 */
export interface Actor {
  kind: "human" | "service";
  /** A person's email; absent on a service token. */
  email?: string;
  /** A service token's Client ID, when the token names one; absent on a person. */
  token_id?: string;
  /** The client a person's request came through, as it named itself; null when it named
   *  none, and on a service token, which already names the program. */
  client: string | null;
}

/** GET /api/whoami: who this request signed in as, and how. */
export interface WhoamiResponse {
  principal: Actor;
  auth: { mode: "access" | "dev" };
}
