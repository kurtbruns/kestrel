# How Kestrel's changes land

## Keep the docs in sync

Changing what the system does, or how the admin UI presents it, means changing the governing document in the same commit: behavior and guarantees in `docs/SPEC.md`, the API's shape (a new wire field, header, error code, or way of reading) in `docs/API.md`, admin-UI presentation in `docs/DESIGN.md`, and `README.md` when the change is visible to whoever runs the app. Code and its docs drifting apart is a bug. `rules/maintainer.md`, imported below, says how to write those changes.

A user-facing or operator-visible change also earns a one-line `CHANGELOG.md` entry under `[Unreleased]` in the same commit; an internal-only change gets none. `rules/changelog.md`, imported below, says which section and how to cut a release.

A change to what an operator does, in the setup guide or in how they reach the API, checks `.claude/CLAUDE.md` in the same commit, since it mirrors the guide.

## Pull requests

**Land a pull request by squash,** one gated commit with the PR's title and description as its message. Rebase-merge a branch whose commits were shaped on purpose (each coherent, with its own message, no sync merges). A merge commit only when a branch's merges cannot be replayed and its commits are worth keeping anyway, since it puts every sync merge into `main` forever. A stack is a review shape, not a merge shape: land it in order, squash each, and rebase the next onto the new `main`.

## GitHub issues

When the user asks you to change what an issue asks for, rewrite its body instead of adding a comment, since whoever picks it up often reads only the body. Work the change in where it belongs rather than appending, with no "Updated:" line; GitHub keeps the edit history.
