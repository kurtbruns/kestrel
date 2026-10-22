# Connect Claude

Connecting Claude to Kestrel lets you publish by asking Claude. It drafts, tests, and schedules posts as you, and its changes show as yours, via Claude.

**Your Kestrel instance has to allow this first,** as [Allow Claude to connect](../guides/01-allow-claude.md) describes.

How you connect depends on where you talk to Claude:

- **In Claude Desktop or claude.ai,** add Kestrel as a connector.
- **In Claude Code,** add Kestrel as a connector, or sign in with the Kestrel CLI to use the API directly.

## Claude Desktop or claude.ai

1. In Claude, go to **Customize → Connectors**, select **Add**, then **Add custom connector**.
1. Name it, and enter your publication's address followed by `/api/mcp`, such as `https://newsletter.example.com/api/mcp`.
1. Under **OAuth client**, choose **Register automatically**.
1. Select **Add**, then sign in the way you do for the dashboard, and approve the sign-in.

On a Team or Enterprise plan, an Owner of your Claude organization adds the connector under **Organization settings → Connectors** instead, and you then select **Connect** on it. Anthropic's [custom connectors guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) has the details.

Through the connector, Claude can do almost everything you do in the dashboard. Uploading images and the logo, and erasing a subscriber, stay in the dashboard, and Claude tells you when something is yours to finish there.

To check it works, ask Claude what your publication is called.

## Claude Code

Claude Code can use the same connector as Claude Desktop and claude.ai. To reach the whole API instead, images included, sign Claude Code in with the Kestrel CLI:

1. Run this, with your publication's address:

    ```bash
    npx -p @kurtbruns/kestrel kestrel login https://newsletter.example.com
    ```

1. Approve the sign-in in the browser that opens. The terminal then says who you're signed in as.

Claude Code then calls Kestrel's API as you, the way `gh` calls GitHub, and its changes show as yours, via Claude Code. The sign-in stays on your computer. In your instance's repository, Claude Code also follows its instructions for Claude.

## How long a sign-in lasts

The sign-in renews itself while you use Claude, until your instance's grant session ends, a week if it follows the setup guide. Then Claude asks you to approve a new one.

To disconnect, remove the connector under **Customize → Connectors**. To sign out of the Kestrel CLI, run `npx -p @kurtbruns/kestrel kestrel logout`.

## Working with Claude

Ask Claude in plain words, the way you'd ask a colleague, and ask it what it can do: it knows its tools, and reads these pages from Kestrel. For example:

- "Proofread my draft titled 'First frost' and schedule it to go out Friday at 7am."
- "Add jack@example.com to the list."
- "Import the subscribers in this CSV from my old newsletter."

Whatever Claude is asked, Kestrel holds these for any client:

- **Every send waits out the review window,** and you can cancel it until it goes out.
- **What goes out is exactly the copy that was scheduled.** A scheduled post is locked.
- **No one is mailed twice,** and only confirmed subscribers receive a post.
- **An unsubscribe is final** until the reader subscribes again.
- **No one's edit is overwritten.** A save based on an older version is refused.
- **Only you can let an import grow a scheduled send,** in the dashboard.

Claude also asks you first before anything that reaches readers, before accepting an import's attestation for you, and before deleting a draft, clearing a bounce, or re-making a scheduled post's email. That comes from Kestrel's instructions to Claude, not a rule the app enforces. A post's banner and a send's page say who acted and through which Claude, such as "Scheduled by you@example.com via Claude".
