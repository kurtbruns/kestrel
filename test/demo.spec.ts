import { describe, expect, it } from "vitest";
import {
  loadDemo,
  parseDemoPost,
  parseDemoPublication,
  parseFrontMatter,
  postImages,
} from "../src/dev/demo";

// The demo publication lives as Markdown under demo/. These pin the front-matter reader's
// contract: every key it accepts, and a loud, named failure for anything else.

const post = (frontMatter: string, body = "# Title\n\nBody.") =>
  `---\n${frontMatter}\n---\n\n${body}\n`;

describe("demo content", () => {
  it("loads every file under demo/ without error", () => {
    const { publication, posts } = loadDemo();
    expect(publication.name).toBe("Field Notes");
    expect(publication.testRecipients).toEqual([
      "editor@fieldnotes.example",
      "proof@fieldnotes.example",
    ]);
    expect(posts.map((p) => p.status)).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "scheduled",
      "draft",
      "draft",
    ]);
    expect(new Set(posts.map((p) => p.slug)).size).toBe(posts.length);
    // The first issue shows the kestrel photo, found from its Markdown, not a field.
    expect(posts.flatMap((p) => p.images)).toEqual(["kestrel.webp"]);
    // It opens with the operator's email-only test send, to their own address (SPEC §5).
    expect(posts[0]?.bundle).toBe("0-test-email");
    expect(posts[0]?.emailOnly).toBe(true);
    expect(posts[0]?.sentTo).toEqual(["proof@fieldnotes.example"]);
    expect(posts.filter((p) => p.emailOnly)).toHaveLength(1);
    expect(posts[1]?.bundle).toBe("1-the-hovering-hunter");
    expect(posts[1]?.images).toEqual(["kestrel.webp"]);
  });

  it("reads a post's fields and body", () => {
    const p = parseDemoPost(
      "8-owls",
      post("subject: Owls\nslug: owls\nstatus: draft\nedited: 3 days ago", "# Owls\n\nHoo."),
    );
    expect(p).toEqual({
      file: "demo/posts/8-owls/index.md",
      bundle: "8-owls",
      subject: "Owls",
      slug: "owls",
      status: "draft",
      markdown: "# Owls\n\nHoo.",
      images: [],
      editedDaysAgo: 3,
    });
  });

  it("reads a test send: email only, to the addresses it names", () => {
    const p = parseDemoPost(
      "0-test",
      post(
        "subject: Test\nslug: test\nstatus: sent\nemail_only: true\nsent_to: a@x.example, b@x.example",
        "Hi.",
      ),
    );
    expect(p.emailOnly).toBe(true);
    expect(p.sentTo).toEqual(["a@x.example", "b@x.example"]);
  });

  it("refuses email_only that isn't true or false or sits on a draft, and sent_to off a sent post or a real domain", () => {
    for (const fm of [
      "subject: T\nslug: t\nstatus: sent\nemail_only: yes",
      "subject: T\nslug: t\nstatus: draft\nemail_only: true",
      "subject: T\nslug: t\nstatus: scheduled\nsent_to: a@x.example",
      "subject: T\nslug: t\nstatus: sent\nsent_to: someone@gmail.com",
    ]) {
      expect(() => parseDemoPost("9-t", post(fm, "Hi.")), fm).toThrow("demo/posts/9-t/index.md");
    }
  });

  it("finds a post's own images by bare filename, and ignores URLs and paths", () => {
    expect(
      postImages(
        "![a](kestrel.webp) ![b](https://example.com/x.png) ![c](../y.png) ![d](kestrel.webp)",
      ),
    ).toEqual(["kestrel.webp"]);
  });

  it("keeps a colon inside a value", () => {
    const p = parseDemoPost("a.md", post("subject: Owls: a field guide\nslug: owls\nstatus: sent"));
    expect(p.subject).toBe("Owls: a field guide");
  });

  it("refuses a file without front matter, naming the file", () => {
    expect(() => parseFrontMatter("demo/posts/x.md", "# No front matter")).toThrow(
      /demo\/posts\/x\.md: expected a front-matter block/,
    );
  });

  it("refuses unknown, duplicate, and missing keys", () => {
    expect(() =>
      parseDemoPost("a.md", post("subject: A\nslug: a\nstatus: sent\ntitle: A")),
    ).toThrow(/unknown front-matter key "title"/);
    expect(() =>
      parseDemoPost("a.md", post("subject: A\nsubject: B\nslug: a\nstatus: sent")),
    ).toThrow(/"subject" appears twice/);
    expect(() => parseDemoPost("a.md", post("subject: A\nstatus: sent"))).toThrow(/missing "slug"/);
  });

  it("refuses an unknown status, and an edited date on anything but a draft", () => {
    expect(() => parseDemoPost("a.md", post("subject: A\nslug: a\nstatus: published"))).toThrow(
      /status must be sent, scheduled, or draft/,
    );
    expect(() =>
      parseDemoPost("a.md", post("subject: A\nslug: a\nstatus: sent\nedited: 2 days ago")),
    ).toThrow(/"edited" is for drafts/);
  });

  it("refuses a post with no body", () => {
    expect(() => parseDemoPost("a.md", "---\nsubject: A\nslug: a\nstatus: sent\n---\n")).toThrow(
      /has no body/,
    );
  });

  it("splits the publication's test recipients on commas", () => {
    const pub = parseDemoPublication(
      "p.md",
      "---\nname: N\ntagline: T\ntest_recipients: a@x.example ,b@x.example\n---\n",
    );
    expect(pub).toEqual({
      name: "N",
      tagline: "T",
      address: "",
      testRecipients: ["a@x.example", "b@x.example"],
    });
  });
});
