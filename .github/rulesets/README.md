# Branch rulesets

`protect-main.json` is a committed copy of the **Protect main** repository ruleset (Settings → Rules → Rulesets). GitHub does **not** apply this file automatically — it lives here for version history, review, and as a re-importable source of truth.

## What it enforces (on the default branch)

- No branch deletion, no force-push, linear history required.
- Changes land via pull request; squash and rebase are the allowed merge methods (both preserve the required linear history — merge commits are not).
- All PR review threads must be resolved before merge.
- No bypass actors.

There is **no required status check**: this repo has no CI — the quality gate (`npm test`, `npm run typecheck`, `npm run check`) is run by hand before merge (see `CLAUDE.md`). If CI is added later, add a `required_status_checks` rule here pinned to its check context and re-apply.

## Re-apply / update

```bash
# Create (first time):
gh api --method POST repos/kurtbruns/kestrel/rulesets --input .github/rulesets/protect-main.json

# Update an existing ruleset (find <id> via: gh api repos/kurtbruns/kestrel/rulesets):
gh api --method PUT repos/kurtbruns/kestrel/rulesets/<id> --input .github/rulesets/protect-main.json
```

If you edit the ruleset in the GitHub UI, re-export it here so this file stays the source of truth (drift is not detected automatically).
