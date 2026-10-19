import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./support/fixtures";
import { adminAuth, base, readJson } from "./support/http";

// Who acted (SPEC §11): a person or a service token, from the credential, plus the client the
// request came through, which names itself in `Kestrel-Client` and is recorded where a change
// is: on each revision here, and on each import (imports.spec.ts).

beforeEach(resetDatabase);

const PERSON = { email: "you@example.com" };

async function whoami(headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${base}/api/whoami`, { headers });
}

describe("a client names itself on each request (SPEC §11, Who acted)", () => {
  it("reports a person's client as it named itself, a name the app doesn't know included", async () => {
    for (const client of ["editor", "claude-code", "my-script"]) {
      const res = await whoami(await adminAuth({ ...PERSON, client }));
      expect(res.status).toBe(200);
      expect((await readJson(res)).principal).toEqual({
        kind: "human",
        email: "you@example.com",
        client,
      });
    }
  });

  it("reports no client for a person's request that names none", async () => {
    expect((await readJson(await whoami(await adminAuth(PERSON)))).principal.client).toBeNull();
  });

  it("ignores a client's name on a service token's request, since the token names the program", async () => {
    const res = await whoami(await adminAuth({ client: "claude-code" }));
    expect((await readJson(res)).principal).toEqual({
      kind: "service",
      token_id: "kestrel-dev.access",
      client: null,
    });
  });

  it("refuses a malformed name with a 400 naming the header, so a typo is never recorded", async () => {
    for (const client of ["Claude Code", "CLAUDE", "claude_code", "-x", "x-", "a".repeat(33), ""]) {
      for (const who of [PERSON, {}]) {
        const res = await whoami(await adminAuth({ ...who, client }));
        expect(res.status).toBe(400);
        expect(await readJson(res)).toMatchObject({
          error: "bad_request",
          field: "Kestrel-Client",
        });
      }
    }
  });

  it("answers a request with no credential 401 before it reads the name", async () => {
    const res = await whoami({ "Kestrel-Client": "Not A Name" });
    expect(res.status).toBe(401);
  });
});

describe("a revision records the client its author came through (SPEC §4, §11)", () => {
  async function save(
    who: { email?: string; client?: string },
    id?: string,
    base_revision?: string,
  ): Promise<Response> {
    return SELF.fetch(`${base}/api/posts${id ? `/${id}` : ""}`, {
      method: id ? "PUT" : "POST",
      headers: { ...(await adminAuth(who)), "content-type": "application/json" },
      body: JSON.stringify(id ? { markdown: `by ${who.client}`, base_revision } : { subject: "S" }),
    });
  }

  it("records each save's author and client, and answers them on the post and its history", async () => {
    const created = await readJson(await save({ ...PERSON, client: "editor" }));
    const id: string = created.post.id;
    expect(created.post).toMatchObject({ author: "you@example.com", author_client: "editor" });
    let rev: string = created.revision_id;
    const after: Record<string, unknown>[] = [];
    for (const who of [{ ...PERSON, client: "claude-code" }, PERSON, { client: "claude-code" }]) {
      const saved = await readJson(await save(who, id, rev));
      rev = saved.revision_id;
      after.push({ author: saved.post.author, author_client: saved.post.author_client });
    }
    expect(after).toEqual([
      { author: "you@example.com", author_client: "claude-code" },
      { author: "you@example.com", author_client: null },
      { author: "service", author_client: null },
    ]);
    const history = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/revisions`, { headers: await adminAuth() }),
    );
    expect(
      history.revisions.map((r: { author: string; author_client: string | null }) => [
        r.author,
        r.author_client,
      ]),
    ).toEqual([
      ["you@example.com", "editor"],
      ["you@example.com", "claude-code"],
      ["you@example.com", null],
      ["service", null],
    ]);
    const one = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/revisions/2`, { headers: await adminAuth() }),
    );
    expect(one).toMatchObject({ author: "you@example.com", author_client: "claude-code" });
  });

  it("names the newer revision's client on a stale save", async () => {
    const created = await readJson(await save({ ...PERSON, client: "editor" }));
    const id: string = created.post.id;
    await save({ ...PERSON, client: "claude-code" }, id, created.revision_id);
    const stale = await save({ ...PERSON, client: "editor" }, id, created.revision_id);
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({
      error: "stale_revision",
      author: "you@example.com",
      author_client: "claude-code",
    });
  });
});
