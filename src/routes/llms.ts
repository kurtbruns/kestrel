/**
 * `GET /llms.txt`: the instance describing itself to an agent that arrives knowing nothing
 * (SPEC §11), in the llms.txt convention: an H1, a one-line summary, then sections of links.
 * It names the publication, the public pages, and the Markdown an agent reads first, which
 * sits behind Access. Plain text, so it names a gated path for an agent without linking a
 * reader into a login.
 *
 * Generated, never written by hand: each path it names is resolved against the registered
 * routes, and the route's `access` tier decides which section lists it, so the file can't
 * call a gated route public or name one that's gone. The docs' indexes come from the docs
 * themselves, and every URL from the same config the routes are registered at.
 */

import { publicationName } from "../../shared/publication";
import { getSettingsForDisplay } from "../db/settings";
import { docSets } from "../docs";
import type { RequestContext, RouteDef } from "../router";

// The instance's own copies of these pages are gated too, so these point at the project's.

/** Where a publisher learns to sign Claude Code in as themselves, the way an agent comes in. */
export const SIGN_IN_URL = "https://getkestrel.dev/docs/working-with-claude/#connect-claude-code";

/** Where whoever runs the instance learns to make a service token, for a script. */
export const CONNECT_CLAUDE_URL = "https://getkestrel.dev/docs/connect-claude/";

interface Entry {
  title: string;
  origin: string;
  path: string;
  about: string;
}

/** The registered GET route a path reaches, matched as the router matches it. */
function routeFor(defs: readonly RouteDef[], path: string): RouteDef {
  const def = defs.find(
    (d) => d.method === "GET" && new URLPattern({ pathname: d.path }).test({ pathname: path }),
  );
  if (!def) {
    throw new Error(`llms.txt names ${path}, which no GET route serves`);
  }
  return def;
}

function line(e: Entry): string {
  return `- [${e.title}](${e.origin}${e.path}): ${e.about}`;
}

/** The text of `/llms.txt`, from the publication's resolved name ("" when it has none), the
 *  registered routes, and the origins and base path the routes are registered at. */
export function llmsText({
  name,
  defs,
  appOrigin,
  archiveOrigin,
  archiveBasePath,
}: {
  name: string;
  defs: readonly RouteDef[];
  appOrigin: string;
  archiveOrigin: string;
  archiveBasePath: string;
}): string {
  const entries: Entry[] = [
    {
      title: "Archive",
      origin: archiveOrigin,
      path: archiveBasePath,
      about: "every post published to the archive, newest first.",
    },
    {
      title: "Subscribe",
      origin: appOrigin,
      path: "/subscribe",
      about: "the page to join the list.",
    },
    {
      title: "API reference",
      origin: appOrigin,
      path: "/api/reference.md",
      about:
        "read it first: what every route shares, and every route on one line, each resource's full reference linked from it.",
    },
    {
      title: "OpenAPI",
      origin: appOrigin,
      path: "/api/openapi.json",
      about: "the same API as an OpenAPI 3.1 document, for tooling that reads one.",
    },
    ...docSets().map((s) => ({
      title: s.title,
      origin: appOrigin,
      path: `/api/docs/${s.id}.md`,
      about: "the index of these docs, whose pages are served as Markdown too.",
    })),
  ];
  const tier = (access: RouteDef["access"]) =>
    entries.filter((e) => routeFor(defs, e.path).access === access).map(line);

  // One line, whatever the name holds, so the H1 stays a heading.
  const named = name.replace(/\s+/g, " ").trim();
  return [
    `# ${named || "Newsletter"}`,
    "",
    "> A newsletter published with Kestrel. Its archive and subscribe page are public; its API, and the docs for publishing and running it, are behind Cloudflare Access.",
    "",
    "## Public",
    "",
    ...tier("public"),
    "",
    "## Behind Cloudflare Access",
    "",
    "Sign in as the person you work for: `npx kestrel login <this instance's address>` signs in through Cloudflare Access in their browser, and `npx kestrel api <method> <path>` then calls these routes as them. A script that runs with no one present sends a Cloudflare Access service token with every request instead, as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Without a credential, the request is refused.",
    "",
    ...tier("admin"),
    "",
    "## Signing in",
    "",
    `- [Connect Claude Code](${SIGN_IN_URL}): how a publisher signs Claude Code in as themselves.`,
    `- [Connect automation to the API](${CONNECT_CLAUDE_URL}): how whoever runs this instance makes a service token for a script.`,
    "",
  ].join("\n");
}

/** `GET /llms.txt`, from the routes the router registered. */
export async function llmsTxt(c: RequestContext, defs: readonly RouteDef[]): Promise<Response> {
  const { publication } = await getSettingsForDisplay(c.env.DB);
  const body = llmsText({
    name: publicationName(publication.name, c.config.fromAddress),
    defs,
    appOrigin: c.config.appOrigin,
    archiveOrigin: c.config.archiveOrigin,
    archiveBasePath: c.config.archiveBasePath,
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
