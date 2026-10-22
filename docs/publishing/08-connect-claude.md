# Connect Claude

Connect Claude to your Kestrel, and you can publish by asking for it: Claude drafts, tests, and schedules posts as you, and its changes show as yours.

**Your Kestrel instance has to allow this first,** with Managed OAuth on for its Access application, as [Allow Claude to connect](../guides/01-allow-claude.md) describes.

How you connect depends on where you talk to Claude:

- **In Claude Desktop or claude.ai,** add your Kestrel as a connector.
- **In Claude Code,** add the same connector, or sign in with the Kestrel CLI for the whole API.

## Claude Desktop or claude.ai

1. In Claude, go to **Customize → Connectors**, select **Add**, then **Add custom connector**.
1. Name it, and enter your Kestrel's address followed by `/api/mcp`, such as `https://newsletter.example.com/api/mcp`.
1. Under **OAuth client**, choose **Register automatically**.
1. Select **Add**, then sign in the way you do for the dashboard, and approve the sign-in.

On a Team or Enterprise plan, an Owner of your Claude organization adds the connector under **Organization settings → Connectors** instead, and you then select **Connect** on it. Anthropic's [custom connectors guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) has the details.

Through the connector, Claude can do almost everything you do in the dashboard. Uploading images and the logo, and erasing a subscriber, stay in the dashboard, and Claude tells you when something is yours to finish there.

To check it works, ask Claude what your publication is called.

## Claude Code

### With the connector

Add the same connector to Claude Code from a terminal:

```bash
claude mcp add --transport http --scope user kestrel https://newsletter.example.com/api/mcp
```

Then start Claude Code, run `/mcp`, choose **kestrel**, and select **Authenticate**. Your browser opens, and you sign in the way you do for the dashboard. With `--scope user`, the connector is there in every folder you open Claude Code in, with the same tools as in Claude Desktop and claude.ai. Anthropic's [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) has the details.

### With the Kestrel CLI

The Kestrel CLI signs Claude Code in as you for the whole API, images included, the way `gh` works with GitHub. Its changes show as yours, via Claude Code.

1. Run this with your Kestrel's address:

    ```bash
    npx -p @kurtbruns/kestrel kestrel login https://newsletter.example.com
    ```

    Name the package as this command does. An unrelated npm package is called `kestrel`, so a bare `npx kestrel` outside your Kestrel's repository would run it instead.

1. Approve the sign-in in the browser it opens. The terminal then says who you're signed in as.

The sign-in is kept on your computer. Opened in your Kestrel's repository, Claude Code also follows your Kestrel's own instructions for Claude, and can sign in for you when you ask it to connect.

## How long a sign-in lasts

The sign-in renews itself while you use Claude, until your Kestrel's grant session ends, a week if it follows the setup guide. Then Claude asks you to approve a new one.

To disconnect, remove the connector: under **Customize → Connectors** in Claude Desktop or claude.ai, or with `claude mcp remove kestrel` in Claude Code. To sign out of `kestrel login`, run `npx -p @kurtbruns/kestrel kestrel logout`.

## Working with Claude

Ask Claude in plain words, the way you'd ask a colleague, and ask it what it can do: it knows its tools, and reads these pages from your Kestrel. For example:

- "Proofread my draft titled 'First frost' and schedule it to go out Friday at 7am."
- "Add jack@example.com to the list."
- "Import the subscribers in this CSV from my old newsletter."

Whatever Claude is asked, your Kestrel holds these for any client:

- **Every send waits out the review window,** and you can cancel it until it goes out.
- **What goes out is exactly the copy that was scheduled.** A scheduled post is locked.
- **No one is mailed twice,** and only confirmed subscribers receive a post.
- **An unsubscribe is final** until the reader subscribes again.
- **No one's edit is overwritten.** A save based on an older version is refused.
- **Only you can let an import grow a scheduled send,** in the dashboard.

Claude also asks you first before anything that reaches readers, before accepting an import's attestation for you, and before deleting a draft, clearing a bounce, or re-making a scheduled post's email. That comes from your Kestrel's instructions to Claude, not a rule the app enforces. A post's banner and a send's page say who acted and through which Claude, such as "Scheduled by you@example.com via Claude".
