# Connect Claude

Add your Kestrel to Claude as a connector, at your Kestrel's address followed by `/api/mcp`, such as `https://newsletter.example.com/api/mcp`. You sign in once, the way you do for the dashboard, and Claude then works as you, through the same API as the dashboard. What it changes shows as yours, via Claude.

**Your Kestrel has to allow this first,** with Managed OAuth on for its Access application, as [Allow Claude to connect](../guides/01-allow-claude.md) describes. If Claude says it couldn't connect or sign in, [Claude can't connect](06-troubleshooting.md#claude-cant-connect) has the fix.

## Which to use

Through the connector, in Claude Desktop, claude.ai, or Claude Code, Claude can do almost everything you do in the dashboard. Uploading images and the logo, and erasing a subscriber, stay in the dashboard, and Claude tells you when something is yours to finish there.

If you also work in your Kestrel's repository, Claude Code can [connect from the repository](#claude-code-in-your-kestrels-repository) instead. It then reaches the whole API, images included, and follows your Kestrel's own instructions for Claude.

## Claude Desktop or claude.ai

1. In Claude, go to **Customize → Connectors**, select **Add**, then **Add custom connector**.
1. Name it, and enter your Kestrel's address followed by `/api/mcp`, exactly.
1. Under **OAuth client**, choose **Register automatically**.
1. Select **Add**, then sign in the way you do for the dashboard, and approve the sign-in.

On a Team or Enterprise plan, an Owner of your Claude organization adds the connector under **Organization settings → Connectors** instead, and you then select **Connect** on it. Anthropic's [custom connectors guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) has the details.

To check it works, ask Claude what your publication is called.

## Claude Code

Add the same connector to Claude Code from a terminal:

```bash
claude mcp add --transport http --scope user kestrel https://newsletter.example.com/api/mcp
```

Then start Claude Code, run `/mcp`, choose **kestrel**, and select **Authenticate**. Your browser opens, and you sign in the way you do for the dashboard. With `--scope user`, the connector is there in every folder you open Claude Code in. Anthropic's [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) has the details.

## Claude Code in your Kestrel's repository

In your Kestrel's repository, `kestrel login` signs Claude Code in as you for the whole API. Its changes show as yours, via Claude Code.

1. In the repository, run this with your Kestrel's address:

    ```bash
    npx -p @kurtbruns/kestrel kestrel login https://newsletter.example.com
    ```

    Name the package as this command does. An unrelated npm package is called `kestrel`, so a bare `npx kestrel` outside the repository would run it instead.

1. Approve the sign-in in the browser it opens. The terminal then says who you're signed in as.

You can also ask Claude Code to connect, and it runs the same command for you to approve. The sign-in is kept on your computer, never in the repository.

## How long a sign-in lasts

The sign-in renews itself while you use Claude, until your Kestrel's grant session ends, a week if it follows the setup guide. Then Claude asks you to approve a new one.

To disconnect, remove the connector: under **Customize → Connectors** in Claude Desktop or claude.ai, or with `claude mcp remove kestrel` in Claude Code. To sign out of `kestrel login`, run `npx -p @kurtbruns/kestrel kestrel logout`.

## Working with Claude

Ask Claude in plain words, the way you'd ask a colleague, and ask it what it can do: it knows its tools, and reads these pages from your Kestrel. For example:

- "Proofread my draft titled 'First frost' and schedule it to go out Friday at 7am."
- "How did last week's post do?"
- "Import the subscribers in this CSV from my old newsletter."

Whatever Claude is asked, your Kestrel holds these for any client:

- **Every send waits out the review window,** and you can cancel it until it goes out.
- **What goes out is exactly the copy that was scheduled.** A scheduled post is locked.
- **No one is mailed twice,** and only confirmed subscribers receive a post.
- **An unsubscribe is final** until the reader subscribes again.
- **No one's edit is overwritten.** A save based on an older version is refused.
- **Only you can let an import grow a scheduled send,** in the dashboard.

Claude also asks you first before anything that reaches readers, before accepting an import's attestation for you, and before deleting a draft, clearing a bounce, or re-making a scheduled post's email. That comes from your Kestrel's instructions to Claude, not a rule the app enforces. A post's banner and a send's page say who acted and through which Claude, such as "Scheduled by you@example.com via Claude".
