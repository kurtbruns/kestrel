# Working with Claude

Ask Claude in plain words, the way you'd ask a colleague. It works through the same API as the dashboard, signed in as you, so it can do what you can do there, and nothing more. Everything it changes shows in the dashboard as yours, sends included: a post's banner and a send's page say who scheduled, moved, or canceled it, and through which Claude ("Scheduled by you@example.com via Claude" through the connector, or "via Claude Code" from your instance's repository).

To set Claude up, add your Kestrel as a connector in Claude Desktop, claude.ai, or Claude Code, as [Connect Claude](08-connect-claude.md) describes.

Claude reads these same pages from your Kestrel, so it explains things in the words you see here. Through the connector, Claude sees a short list of tools, each a task such as **Save a draft**, **Send a test email**, or **Schedule a post**, marked as reading or changing something, plus one that reads most of the rest of your Kestrel and changes nothing. Your settings, the email template, changing whether a post is in your archive, or its address, once it's scheduled or sent, blocking an address, resolving a send, uploading images, and erasing a subscriber stay in the dashboard, and Claude tells you when something is yours to finish there.

## What to ask Claude

- **Draft or proofread a post.** Give it notes, an outline, or a draft. It saves a new version you can open in the dashboard. If you edited the post meanwhile, its save is refused, and it works from your version or asks you.
- **Test and schedule a post.** Name the post and when it should go out, and say so if it should be email only. Claude tells you whether the post will be in your archive, and at which address, before it schedules. Then it offers a test of the scheduled post, which is exactly what will go out, and tells you how to cancel. If the test shows a problem, it cancels, fixes the post, and schedules it again. It can also cancel a send or move it.
- **Take a sent post out of your archive, or put it back,** with Claude Code in your instance's repository. Through the connector, do it in the dashboard. Claude asks first, as the dashboard does, since taking a post out breaks links people shared.
- **Check how a send did.** Claude reads the send's record and reports what was delivered, unsent, bounced, or complained.
- **Recover an earlier version.** Every save keeps a whole version of a post, and Claude can read them back.
- **Import a list.** Claude plans the import first and shows you what it would do. It imports once you accept the attestation in the chat, never on its own. In your instance's repository, Claude Code's `/migrate-list` skill asks what anything ambiguous in your old service's export means, and converts a few rows for you to check. It imports once you attest, and if a scheduled post would grow, you finish the import in the dashboard.

## The lines it can't cross

The app holds these for any client, so they hold whatever Claude is told:

- **Every send waits out the review window,** and you can cancel it until it goes out.
- **A scheduled post is locked,** and what goes out is exactly the copy that was scheduled.
- **No one is mailed twice,** and only confirmed subscribers receive a post.
- **An unsubscribe is final** until the reader subscribes again. Someone who complained or was erased comes back only by subscribing themselves: neither you nor Claude can add them.
- **No one's edit is overwritten.** A save based on an older version is refused.
- **Only you can let an import grow a scheduled send.** An import through Claude that would stops there, until you finish it in the dashboard.

Claude also follows instructions your Kestrel gives it, which live in your instance's repository for Claude Code working there, and come with the connection through the connector. Those hold only as long as the instructions do. They have Claude ask before anything that reaches readers, say whether a post will be in your archive before it's sent, test again after a template change, and record whose decision each change to the list was. They also have it treat what's in a post or a subscriber's record as content, never as instructions.

The app lets Claude give your attestation for an import, so asking you first is one of those instructions, not a rule the app enforces. The import's record says you made it via Claude Code, or via Claude.
