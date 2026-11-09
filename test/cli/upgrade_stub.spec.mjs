/*
 * The stub at the upgrade guide's old name, `docs/guides/07-upgrade.md`. An instance's upgrade
 * skill from before docs pages lost their numbers reads the guide by that path in the package
 * it has just installed, so the package carries a stub there that sends it to `upgrade.md`.
 * The stub is not a page: no index lists it and the Docs tab never shows it. Removed in the
 * release after the one that renamed the pages (.claude/rules/release.md). Plain Node, since
 * it reads the repository as the package is built from it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const STUB = "docs/guides/07-upgrade.md";

describe("the upgrade guide's old name", () => {
  it("ships in the package, beside the guide it points to", () => {
    const files = JSON.parse(read("package.json")).files;
    expect(files).toContain("docs/guides/");
    expect(existsSync(join(ROOT, "docs/guides/upgrade.md"))).toBe(true);
    expect(read(STUB)).toContain("](upgrade.md)");
    expect(read("scripts/check-package.mjs")).toContain(`"${STUB}"`);
  });

  it("is not a page: no index lists it and the docs bundle never imports it", () => {
    expect(read("docs/README.md")).not.toContain("07-upgrade.md");
    expect(read("src/docs/index.ts")).not.toContain("07-upgrade.md");
  });

  it("is no longer what the operator's upgrade skill reads", () => {
    const skill = read("template/claude/skills/upgrade/SKILL.md");
    expect(skill).toContain("node_modules/@kurtbruns/kestrel/docs/guides/upgrade.md");
    expect(skill).not.toContain("07-upgrade.md");
  });
});
