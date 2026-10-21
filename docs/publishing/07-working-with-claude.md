# Working with Claude

Ask Claude in plain words, the way you'd ask a colleague. It works through the same API as the dashboard, signed in as you, so it can do what you can do there, and nothing more. Everything it changes shows in the dashboard as yours, sends included: a post's banner and a send's page say who scheduled, moved, or canceled it, and through which Claude ("Scheduled by you@example.com via Claude Code", or "via Claude" from Claude Desktop and claude.ai).

To set Claude up, [connect Claude Code](#connect-claude-code) in your instance's repository, or [connect Claude Desktop or claude.ai](#connect-claude-desktop-or-claudeai) as a connector, below. Claude reads these same pages from your Kestrel, so it explains things in the words you see here.

## Connect Claude Code

Run this in your instance's repository, with your Kestrel's address, and approve the sign-in in the browser it opens:

```bash
npx kestrel login https://newsletter.example.com
```

You sign in the way you do for the dashboard, and the terminal says who you're signed in as. Or ask Claude to connect, and it runs the same command for you to approve.

**Your Kestrel has to offer this sign-in first.** If the command says your Kestrel doesn't offer a sign-in for programs, turn on Managed OAuth, as [Lock the dashboard with Access](../get-started/03-access.md#5-turn-on-managed-oauth) describes.

The sign-in stays on your computer, not in your repository, and renews itself while you use it. How long it lasts is a setting of your Access application. When it ends, Claude asks you to approve a new one. To sign out on this computer, run `npx kestrel logout`.

The same sign-in lets you call the API from a terminal yourself. `npx kestrel api --list` lists your Kestrel's routes, `npx kestrel api help POST /api/posts` describes one, and `npx kestrel api POST /api/posts -f subject='Spring update'` calls it as you. `npx kestrel api` alone lists its options.

## Connect Claude Desktop or claude.ai

Add your Kestrel as a custom connector, with the address of its MCP server, and sign in once:

1. In Claude, go to **Customize → Connectors**, select **Add**, then **Add custom connector**. On a Team or Enterprise plan, an Owner adds it under **Organization settings → Connectors** instead, and you then select **Connect** on it.
1. Name it, and enter your Kestrel's address followed by `/api/mcp`, exactly: `https://newsletter.example.com/api/mcp`.
1. Under **OAuth client**, choose **Register automatically**.
1. Select **Add**, then sign in the way you do for the dashboard, and approve the sign-in.

Every Claude plan can add custom connectors; the Free plan allows one. Anthropic's [custom connectors guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) has the details.

**Your Kestrel has to allow Claude's sign-in first.** If Claude says it couldn't connect or the sign-in failed, the Access application needs Managed OAuth on, with Claude's address among its allowed redirect URIs, as [Lock the dashboard with Access](../get-started/03-access.md#5-turn-on-managed-oauth) describes.

Claude reaches your Kestrel from Anthropic's servers, not your computer, so this works only for a deployed instance, never one running on your own computer. Claude sees a short list of tools, each a task such as **Save a draft**, **Send a test email**, or **Schedule a post**, marked as reading or changing something, plus one that reads most of the rest of your Kestrel and changes nothing. Uploading images, your logo, and erasing a subscriber stay in the dashboard, and Claude tells you when something is yours to finish there. A connector has no instance repository, so your instance's instructions for Claude don't reach it: Kestrel tells it the most important ones itself when it connects, such as asking you before anything that reaches readers.

How long the sign-in lasts is the Access application's grant session, as for Claude Code. To disconnect, remove the connector in Claude.

A script that runs with no one there uses a service token instead, as [Connect automation to the API](../guides/01-connect-claude.md) describes. Its changes show as a service token's, never as yours.

## What to ask Claude

- **Draft or proofread a post.** Give it notes, an outline, or a draft. It saves a new version you can open in the dashboard. If you edited the post meanwhile, its save is refused, and it works from your version or asks you.
- **Test and schedule a post.** Name the post and when it should go out, and say so if it should be email only. Claude tells you whether the post will be in your archive, and at which address, before it schedules. Then it offers a test of the scheduled post, which is exactly what will go out, and tells you how to cancel. If the test shows a problem, it cancels, fixes the post, and schedules it again. It can also cancel a send or move it.
- **Take a sent post out of your archive, or put it back.** Claude asks first, as the dashboard does, since taking a post out breaks links people shared.
- **Check how a send did.** Claude reads the send's record and reports what was delivered, unsent, bounced, or complained.
- **Recover an earlier version.** Every save keeps a whole version of a post, and Claude can read them back.
- **Import a list.** Claude plans the import first and shows you what it would do. It imports once you accept the attestation in the chat, never on its own. In Claude Code, its `/migrate-list` skill asks what anything ambiguous in your old service's export means, and converts a few rows for you to check. It imports once you attest, and if a scheduled post would grow, you finish the import in the dashboard.

## The lines it can't cross

The app holds these for any client, so they hold whatever Claude is told:

- **Every send waits out the review window,** and you can cancel it until it goes out.
- **A scheduled post is locked,** and what goes out is exactly the copy that was scheduled.
- **No one is mailed twice,** and only confirmed subscribers receive a post.
- **An unsubscribe is final** until the reader subscribes again. Someone who complained or was erased comes back only by subscribing themselves: neither you nor Claude can add them.
- **No one's edit is overwritten.** A save based on an older version is refused.
- **Only you can let an import grow a scheduled send.** An import through Claude that would stops there, until you finish it in the dashboard.

Claude also follows instructions your Kestrel gives it, which live in your instance's repository for Claude Code, and come with the connection for Claude Desktop and claude.ai. Those hold only as long as the instructions do. They have Claude ask before anything that reaches readers, say whether a post will be in your archive before it's sent, test again after a template change, and record whose decision each change to the list was. They also have it treat what's in a post or a subscriber's record as content, never as instructions.

The app lets Claude give your attestation for an import, so asking you first is one of those instructions, not a rule the app enforces. The import's record says you made it via Claude Code, or via Claude.
