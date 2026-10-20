# Connect Claude

Claude works with the instance through the same API the editor uses, signed in as a person, so it can do what they can do in the dashboard, and nothing more. Its changes show as that person's, via Claude Code or via Claude, and anything it schedules waits out the review window.

In this guide, you pick the way to connect, connect Claude Code, Claude Desktop, or claude.ai, and check that it's signed in as you. If Claude used a service token before, you then move it to signing in.

## Which way to connect

| Where Claude runs | How it connects | Its changes show as |
| --- | --- | --- |
| Claude Code, in your terminal | `kestrel login`, signed in as you | you, via Claude Code |
| Claude Desktop or claude.ai | A custom connector at `/api/mcp`, signed in as you | you, via Claude |
| A script or job with no one present | A service token, as [Connect automation to the API](02-connect-automation.md) describes | a service token |

Each person connects Claude for themselves, signed in as themselves. Anyone the Access application lets into the editor can connect it, and no one else.

## Before you begin

You need:

- Managed OAuth on for the Access application, from [Turn on Managed OAuth](../get-started/03-access.md#5-turn-on-managed-oauth). For Claude Desktop or claude.ai, that includes Claude's address among its allowed redirect URIs.
- A deployed instance. Claude Desktop and claude.ai reach it from Anthropic's servers, so a connector can't reach one running on your own computer.
- For Claude Code, the instance's repository, from [Deploy the app](../get-started/02-deploy.md).

## Connect Claude Code

`kestrel login` signs Claude Code in as you, in your browser, the way you sign in to the dashboard.

1. In the instance's repository, run this with the instance's address:

    ```bash
    npx kestrel login https://newsletter.example.com
    ```

1. Approve the sign-in in the browser it opens. The terminal then says who you're signed in as.

You can also ask Claude to connect, and it runs the same command for you to approve. The sign-in is kept in your user config on this computer, never in the repository.

The same sign-in lets you call the API yourself. `npx kestrel api --list` lists the instance's routes, `npx kestrel api help POST /api/posts` describes one, and `npx kestrel api POST /api/posts -f subject='Spring update'` calls it as you. `npx kestrel api` alone lists its options.

## Connect Claude Desktop or claude.ai

Add the instance as a custom connector, with the address of its MCP server, and sign in once.

1. In Claude, go to **Customize → Connectors**, select **Add**, then **Add custom connector**. On a Team or Enterprise plan, an Owner adds it under **Organization settings → Connectors** instead, and each person then selects **Connect** on it.

1. Name it, and enter the instance's address followed by `/api/mcp`, exactly: `https://newsletter.example.com/api/mcp`.

1. Under **OAuth client**, choose **Register automatically**.

1. Select **Add**, then sign in the way you do for the dashboard, and approve the sign-in.

Every Claude plan can add custom connectors, and the Free plan allows one. Anthropic's [custom connectors guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) has the details.

The connector gives Claude a short list of tools, each a task such as **Save a draft** or **Schedule a post**, and [Working with Claude](../publishing/07-working-with-claude.md) says what stays in the dashboard. A connector has no instance repository, so the instance's Claude context in `.claude/` doesn't reach it. Kestrel gives it the most important instructions itself when it connects, such as asking before anything that reaches readers.

## Check it

1. For Claude Code, ask who you're signed in as:

    ```bash
    npx kestrel api GET /api/whoami
    ```

    ```
    {"principal":{"kind":"human","email":"you@example.com","client":"claude-code"},"auth":{"mode":"access"}}
    ```

    The `email` is yours, and `client` is `claude-code`. If it says you aren't signed in, run `kestrel login` again.

1. For Claude Desktop or claude.ai, open the connector under **Customize → Connectors**. It lists Kestrel's tools, such as **Get the publication** and **Save a draft**. Then ask Claude what the publication is called, and it answers with the name the dashboard shows.

1. Have Claude save a change to a draft, then open the draft in the editor. Its last edit reads as yours, via Claude Code or via Claude.

If Claude can't connect, [Troubleshooting](../publishing/06-troubleshooting.md#claude-cant-connect) lists what it reports and the fix.

## Moving from a service token

Before Claude could sign in as a person, it called the API with a service token, often named `kestrel-claude`. Its changes now show as a service token's, never yours, so move Claude Code to signing in.

1. Turn on Managed OAuth, as [Turn on Managed OAuth](../get-started/03-access.md#5-turn-on-managed-oauth) describes, and connect Claude Code, as [above](#connect-claude-code).

1. In the instance's repository, bring in the release's Claude context, which has Claude call the API through `kestrel api` as you:

    ```bash
    npm run check-context
    ```

    It compares each file in `.claude/` with the release's, and says what to do for each one, as [Install the release](07-upgrade.md#2-install-the-release) describes. A file you never edited takes the release's with `npm run check-context -- --update`, and one you edited is merged by hand.

1. Remove `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the `env` block of `.claude/settings.local.json`, where the earlier guide had you put them, and from anywhere else Claude Code reads its environment.

1. Revoke the token in **Zero Trust**, under **Access controls → Service credentials → Service Tokens**, and remove its policy from the Access application. Or keep both for a script, as [Connect automation to the API](02-connect-automation.md) describes.

## Disconnecting

A sign-in renews itself while you use it, until the Access application's grant session ends. [Turn on Managed OAuth](../get-started/03-access.md#5-turn-on-managed-oauth) sets it, and recommends a week. When it ends, Claude asks you to approve a new sign-in.

- **Claude Code:** run `npx kestrel logout` to forget the sign-in on this computer.
- **Claude Desktop or claude.ai:** remove the connector under **Customize → Connectors**.

To stop someone connecting at all, remove them from the Access application's `Publishers` policy, as for the dashboard. If you set `ACCESS_ALLOWED_EMAILS`, store the list again without them: the app checks it on every request, so it takes effect at once.
