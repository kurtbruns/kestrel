# Working with Claude

Ask Claude in plain words, the way you'd ask a colleague. It works through the same API as the dashboard, signed in as you, so it can do what you can do there, and nothing more. Everything it changes shows in the dashboard as yours, via Claude Code, sends included: a post's banner and a send's page say who scheduled, moved, or canceled it ("Scheduled by you@example.com via Claude Code").

To set Claude up, [connect Claude Code](#connect-claude-code), below. Claude reads these same pages from your Kestrel, so it explains things in the words you see here.

## Connect Claude Code

Run this in your instance's repository, with your Kestrel's address, and approve the sign-in in the browser it opens:

```bash
npx kestrel login https://newsletter.example.com
```

You sign in the way you do for the dashboard, and the terminal says who you're signed in as. Or ask Claude to connect, and it runs the same command for you to approve.

**Your Kestrel has to offer this sign-in first.** If the command says your Kestrel doesn't offer a sign-in for programs, turn on Managed OAuth, as [Lock the dashboard with Access](../get-started/03-access.md#5-turn-on-managed-oauth) describes.

The sign-in stays on your computer, not in your repository, and renews itself while you use it. How long it lasts is a setting of your Access application. When it ends, Claude asks you to approve a new one. To sign out on this computer, run `npx kestrel logout`.

The same sign-in lets you call the API from a terminal yourself. `npx kestrel api --list` lists your Kestrel's routes, `npx kestrel api help POST /api/posts` describes one, and `npx kestrel api POST /api/posts -f subject='Spring update'` calls it as you. `npx kestrel api` alone lists its options.

A script that runs with no one there uses a service token instead, as [Connect automation to the API](../guides/01-connect-claude.md) describes. Its changes show as a service token's, never as yours.

## What to ask Claude

- **Draft or proofread a post.** Give it notes, an outline, or a draft. It saves a new version you can open in the dashboard. If you edited the post meanwhile, its save is refused, and it works from your version or asks you.
- **Test and schedule a post.** Name the post and when it should go out, and say so if it should be email only. Claude tells you whether the post will be in your archive, and at which address, before it schedules. Then it sends a test of exactly what will go out and tells you how to cancel. It can also cancel a send or move it.
- **Take a sent post out of your archive, or put it back.** Claude asks first, as the dashboard does, since taking a post out breaks links people shared.
- **Check how a send did.** Claude reads the send's record and reports what was delivered, unsent, bounced, or complained.
- **Recover an earlier version.** Every save keeps a whole version of a post, and Claude can read them back.
- **Import a list.** Its `/migrate-list` skill asks what anything ambiguous in your old service's export means, and converts a few rows for you to check. It imports once you attest, and if a scheduled post would grow, you finish the import in the dashboard.

## The lines it can't cross

The app holds these for any client, so they hold whatever Claude is told:

- **Every send waits out the review window,** and you can cancel it until it goes out.
- **A scheduled post is locked,** and what goes out is exactly the copy that was scheduled.
- **No one is mailed twice,** and only confirmed subscribers receive a post.
- **An unsubscribe is final** until the reader subscribes again. Someone who complained or was erased comes back only by subscribing themselves: neither you nor Claude can add them.
- **No one's edit is overwritten.** A save based on an older version is refused.
- **Only you can let an import grow a scheduled send.** An import through Claude that would stops there, until you finish it in the dashboard.

Claude also follows instructions your Kestrel gives it, which live in your instance's repository. Those hold only as long as the instructions do. They have Claude ask before anything that reaches readers, say whether a post will be in your archive before it's sent, test again after a template change, and record whose decision each change to the list was. They also have it treat what's in a post or a subscriber's record as content, never as instructions.

The app lets Claude give your attestation for an import, so asking you first is one of those instructions, not a rule the app enforces. The import's record says you made it via Claude Code.
