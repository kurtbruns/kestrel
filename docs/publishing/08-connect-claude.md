# Connect Claude

Add your Kestrel to Claude as a connector, at your Kestrel's address followed by `/api/mcp`, such as `https://newsletter.example.com/api/mcp`. You sign in once, the way you do for the dashboard, and Claude then works as you. What it changes shows as yours, via Claude.

**Your Kestrel has to allow this first,** with Managed OAuth on for its Access application, as [Allow Claude to connect](../guides/01-allow-claude.md) describes. If Claude says it couldn't connect or sign in, [Claude can't connect](06-troubleshooting.md#claude-cant-connect) has the fix.

## Claude Desktop or claude.ai

1. In Claude, go to **Customize → Connectors**, select **Add**, then **Add custom connector**.
1. Name it, and enter your Kestrel's address followed by `/api/mcp`, exactly.
1. Under **OAuth client**, choose **Register automatically**.
1. Select **Add**, then sign in the way you do for the dashboard, and approve the sign-in.

On a Team or Enterprise plan, an Owner of your Claude organization adds the connector under **Organization settings → Connectors** instead, and you then select **Connect** on it. Every Claude plan can add custom connectors, and the Free plan allows one. Anthropic's [custom connectors guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) has the details.

Once it's connected, the connector lists Kestrel's tools, such as **Get the publication** and **Save a draft**. Ask Claude what your publication is called to check that it works.

## Claude Code

Add the same connector to Claude Code from a terminal, then sign in from inside Claude Code:

```bash
claude mcp add --transport http --scope user kestrel https://newsletter.example.com/api/mcp
```

Then start Claude Code, run `/mcp`, choose **kestrel**, and select **Authenticate**. Your browser opens, and you sign in the way you do for the dashboard. With `--scope user`, the connector is there in every folder you open Claude Code in. Anthropic's [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) has the details.

If you also run your Kestrel and work in its repository, Claude Code can instead sign in there for the whole API, as [Allow Claude to connect](../guides/01-allow-claude.md#3-optional-sign-claude-code-in-from-the-instances-repository) describes. Its changes then read via Claude Code.

## How long a sign-in lasts

The sign-in renews itself while you use Claude, until your Kestrel's grant session ends, a week if it follows the setup guide. Then Claude asks you to approve a new one.

To disconnect, remove the connector: under **Customize → Connectors** in Claude Desktop or claude.ai, or with `claude mcp remove kestrel` for Claude Code.

