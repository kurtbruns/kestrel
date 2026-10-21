# Allow Claude to connect

Claude works with the instance through the same API the editor uses, signed in as a person through the Access application. It can do what that person can do in the dashboard, and nothing more. Its changes show as theirs, via Claude or via Claude Code, and anything it schedules waits out the review window.

For Claude to sign in, the Access application needs Cloudflare's Managed OAuth turned on. In this guide, you turn it on, allow the addresses Claude signs in from, and choose how long a sign-in lasts. Then you send the publisher the address they connect to, and check it.

## How Claude connects

| Who | Where | How it connects | Its changes show as |
| --- | --- | --- | --- |
| The publisher | Claude Desktop, claude.ai, or Claude Code | The instance's MCP server, `https://newsletter.example.com/api/mcp`, as [Connect Claude](../publishing/08-connect-claude.md) describes | the publisher, via Claude |
| You, in the instance's repository | Claude Code | `kestrel login`, for the whole API, as [section 3](#3-optional-sign-claude-code-in-from-the-instances-repository) describes | you, via Claude Code |
| A script or job with no one present | Anywhere | A service token, as [Give a script access to the API](02-script-access.md) describes | a service token |

The first two need Managed OAuth, and nothing else on the instance. A service token doesn't.

## Before you begin

You need:

- The dashboard locked with Access, from [Lock the dashboard with Access](../get-started/03-access.md).
- A deployed instance. Claude Desktop and claude.ai reach it from Anthropic's servers, so they can't reach one running on your own computer.

## 1. Turn on Managed OAuth

Managed OAuth lets a program sign in as a person, the way the editor does in a browser. Cloudflare marks it as beta, and its [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) page describes it.

1. In **Zero Trust**, go to **Access controls → Applications**, and select **Edit** on your application.

1. On the **Additional settings** tab, select the **OAuth** filter, and find **Managed OAuth (Beta)**.

1. Turn on **Managed OAuth**.

1. Turn on **Allow localhost clients** and **Allow loopback clients**. Claude Code receives the person's approval on their own computer, at a `localhost` or `127.0.0.1` address.

1. Under **Allowed redirect URIs**, add Claude's sign-in address, so Claude Desktop and claude.ai can connect:

    ```
    https://claude.ai/api/mcp/auth_callback
    ```

    Claude registers itself with Access when the publisher adds the connector, and Access accepts it only with an address listed here. Leave it out if no one will connect Claude Desktop or claude.ai.

1. Keep the **Access token lifetime** at 15 minutes. A program renews its access token while it's in use, so a short lifetime costs nothing.

1. Save the application.

With Managed OAuth on, a program that asks for a page without signing in gets a `401` that tells it how to sign in, instead of Cloudflare's login page. A browser still gets the login page.

## 2. Choose how long a sign-in lasts

A program's sign-in renews itself while it's in use, until the grant session ends. Then Claude asks the person to approve a new one.

1. On the same **Managed OAuth** settings, choose the **Grant session duration**. It defaults to **Same as session duration**, the session you chose in [Create the Access application](../get-started/03-access.md#2-create-the-access-application).

1. Set it to 1 week. Cloudflare recommends one to two weeks for a command-line tool, and a week means Claude asks for approval once a week, not every day.

1. Save the application.

## 3. (Optional) Sign Claude Code in from the instance's repository

`kestrel login` signs Claude Code in as you, for the whole API rather than the connector's short list of tools. Claude Code also reads the instance's instructions for Claude from `.claude/` in the repository, so this is the way in for setup, upgrades, and anything the connector leaves to the dashboard.

1. In the instance's repository, run this with the instance's address:

    ```bash
    npx -p @kurtbruns/kestrel kestrel login https://newsletter.example.com
    ```

    Always name the package as this command does. An unrelated npm package is called `kestrel`, so a bare `npx kestrel` outside the repository would download and run it.

1. Approve the sign-in in the browser it opens. The terminal then says who you're signed in as.

You can also ask Claude Code to connect, and it runs the same command for you to approve. The sign-in is kept in your user config on this computer, never in the repository.

The same sign-in lets you call the API yourself:

- `npx -p @kurtbruns/kestrel kestrel api --list` lists the instance's routes.
- `npx -p @kurtbruns/kestrel kestrel api help POST /api/posts` describes one.
- `npx -p @kurtbruns/kestrel kestrel api POST /api/posts -f subject='Spring update'` calls it as you.

A script of your own can name itself with `--client`, such as `--client my-script`, so its changes read "via my-script". `kestrel api` refuses `--client editor`, since only the editor names itself the editor. To sign out on this computer, run `npx -p @kurtbruns/kestrel kestrel logout`.

## 4. Tell the publisher

If someone else is the publisher, send them:

- The connector's address, `https://newsletter.example.com/api/mcp`.
- A link to [Connect Claude](../publishing/08-connect-claude.md).

They sign in the way they do for the dashboard, so the `Publishers` policy already decides whether they can connect. To stop someone connecting, remove them from that policy. If you set `ACCESS_ALLOWED_EMAILS`, store the list again without them: the app checks it on every request, so it takes effect at once.

## Check it

1. A request with no sign-in names where a program signs in:

    ```bash
    curl -si https://newsletter.example.com/api/whoami
    ```

    It answers `401`, and its `www-authenticate` line starts with `Bearer` and names `resource_metadata`. Without Managed OAuth, Cloudflare answers with a redirect to its login page instead. The MCP server at `https://newsletter.example.com/api/mcp` answers the same way, since the `api` path covers it.

1. If you signed Claude Code in, ask who you're signed in as:

    ```bash
    npx -p @kurtbruns/kestrel kestrel api GET /api/whoami
    ```

    ```
    {"principal":{"kind":"human","email":"you@example.com","client":"claude-code"},"auth":{"mode":"access"}}
    ```

1. Connect Claude Desktop or claude.ai yourself, as [Connect Claude](../publishing/08-connect-claude.md) describes. It lists Kestrel's tools, such as **Get the publication** and **Save a draft**.

If Claude can't connect, [Claude can't connect](../publishing/06-troubleshooting.md#claude-cant-connect) lists what it reports and the fix.
