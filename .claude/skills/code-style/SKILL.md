---
name: Code style
description: Kestrel's TypeScript conventions, covering module shape (header, then imports, then code), naming, and the worker/client differences, plus a repeatable audit to check the tree against them. Use when writing a new module, deciding function-declaration vs arrow or how to shape exports, reviewing a diff for style drift, or auditing the whole codebase for consistency.
---

# Code style

The shape of a module in Kestrel, and the names inside it. Biome and `tsc` own everything they can check (below); this file holds only what they cannot — the conventions consistent enough across `src/`, `client/`, and `shared/` to state as a rule, verified by the audit at the bottom. Where the tree agrees with Google's TypeScript style guide, the rule is stated its way; where the tree does its own thing, the tree wins.

## What the tools already own

Never restate these in a review; `npm run check` and `npm run typecheck` decide them.

- Formatting: 2-space indent, double quotes, semicolons, 100 columns, braces on every `if`/`for` body.
- Import sorting: `organizeImports` sorts and groups the imports it finds at the top. It does not move one that sits below code — that's the rule below.
- `import type` for a type-only import: `verbatimModuleSyntax` rejects the plain form.
- `const` over `let` when never reassigned: `useConst`.
- Indexing: `noUncheckedIndexedAccess` makes `arr[i]` possibly `undefined`. Narrow it, or `unwrap(value, what)` (`src/lib/unwrap.ts`) when a miss is a bug.

## The shape of a module

1. The header comment: one responsibility, in the style CLAUDE.md sets under Comment & doc style.
2. Every `import`, and nothing else above the last one. Not a type, not a constant, not an interface: a reader who has seen code stops looking for imports. This is the one rule the tree doesn't enforce by habit — it's edit-time drift, not a fresh-file mistake, so it's worth a second look on any module you're touching rather than writing from scratch.
3. The code.

- Static imports only. `import()` appears in specs that need a fresh module instance; a module never lazy-loads another.
- Relative paths, no aliases: `../shared/…` from a flat client module, `../../shared/…` from a feature folder. Which tree may import which is in CLAUDE.md and `.claude/rules/client.md`, not here.
- Named exports. The one `export default` is `src/index.ts`, because the Workers runtime looks for it there.
- A top-level function is a `function` declaration. A `const` arrow only when the whole body is one expression (`now`, `newId`, the `HttpError` constructors in `src/lib/errors.ts`, `badge`).

## Names

- Files: `snake_case.ts` (`dev_reload.ts`, `list_controls.ts`, `archive_url.ts`). `scripts/` and `.claude/hooks/` are the exception — kebab-case, matching how the rest of the repo names shell-adjacent tooling.
- Functions and values `camelCase`; types and interfaces `PascalCase`; a module-level tuning knob or sentinel `UPPER_SNAKE` (`FREEZE_RETRIES`, `MAX_BATCH`, `UNSUB_SENTINEL`).
- A name says what the thing is, not its type: `post`, not `postObj`; `sends`, not `sendList`.

## Worker only (`src/`)

- An operator-visible condition logs one line, `console.error("TAG", { ids })`: an uppercase tag, then the identifiers someone would grep by. `src/send/sweep.ts` is the pattern. Nothing else in `src/` writes to the console except the unhandled-error fallback in `lib/errors.ts` and the dev-only send simulation.
- An API route reports a failure by throwing an `HttpError` through the constructors in `src/lib/errors.ts`; `toErrorResponse` shapes the body once. The reader surface (`routes/public.ts`, `routes/archive.ts`) renders a page and picks its own status, since a subscriber sees a page, not JSON.
- Module headers are `/** … */`.

## Client only (`client/`)

The client's own rules (markup, state, view lifecycle, one-way imports, no work at load) are in `.claude/rules/client.md`, which loads with any `client/` file — read that first for anything beyond naming and module shape. Module headers here, and in `shared/`, are `//`, not `/** … */`; both styles are fine, just don't convert one to the other.

## Running the audit

A repeatable check against the rules above, safe to run any time (read-only). Run from the repo root.

```bash
# 1. Imports placed after other code (tracks multi-line `import { ... } from` blocks)
for f in $(find src client shared test -name '*.ts' -not -name '*.d.ts' -not -path '*/generated/*'); do
  awk -v F="$f" '
    in_import { if ($0 ~ /;[[:space:]]*$/) { in_import=0 }; next }
    /^import / {
      if (seen_code) { print F ": line " NR ": " substr($0,1,80) }
      if ($0 !~ /;[[:space:]]*$/) { in_import=1 }
      next
    }
    /^(\/\/|\/\*| \*|\*\/|$)/ { next }
    { seen_code=1 }
  ' "$f"
done

# 2. Dynamic import() outside specs
grep -rln "import(" src client shared --include='*.ts' | grep -v '\.spec\.ts$'

# 3. export default outside src/index.ts
grep -rln "^export default" src client shared --include='*.ts' | grep -v '^src/index.ts$'

# 4. Top-level function-vs-arrow ratio, by tree
for d in src client shared; do
  printf "%-7s function: %3s   arrow: %3s\n" "$d" \
    $(grep -rhE "^(export )?(async )?function " "$d" --include='*.ts' --exclude='*.spec.ts' | wc -l) \
    $(grep -rhE "^(export )?const [a-zA-Z_]+ = (async )?\(" "$d" --include='*.ts' --exclude='*.spec.ts' | wc -l)
done

# 5. Non-snake_case file names outside scripts/ and .claude/hooks/
find src client shared test -name '*.ts' | xargs -n1 basename | grep -E '[A-Z]|-'

# 6. client/shared importing src/ (boundary violation)
grep -rn 'from "\.\./src\|from "\.\./\.\./src' client shared --include='*.ts'

# 7. console.* in src/ outside the allowed spots
grep -rn "console\." src --include='*.ts' --exclude='*.spec.ts' | grep -v "^src/dev/"

# 8. Hand-built error Responses in API routes (should throw HttpError instead)
grep -rnE "new Response\(.*(4[0-9]{2}|5[0-9]{2})|status: (4|5)[0-9]{2}" src/routes/*.ts | grep -v "src/routes/public.ts\|src/routes/archive.ts"
```

Empty output on 2, 3, 5, 6, 7, 8 means clean. Check 1's output by hand — a hit is real drift, not a false positive (the awk tracks multi-line imports). Check 4 has no fixed pass/fail threshold; read it as a sanity check that arrows haven't crept up, not a hard gate.
