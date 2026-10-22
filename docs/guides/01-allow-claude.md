# Allow Claude to connect

Connecting Claude to the instance lets the publisher draft, test, and schedule posts by asking for them in Claude. Claude works through the same API as the dashboard, and its changes show as the publisher's, via Claude.

In this guide, you turn on Cloudflare's Managed OAuth for the Access application that locks the dashboard, then connect Claude, or send the publisher the address to connect to.

To run a script or scheduled job with no one present, use a service token instead, as [Automate with a service token](02-automate.md) describes.

## Before you begin

You need:

- The dashboard locked with Access, from [Lock the dashboard with Access](../get-started/03-access.md).
- A deployed instance. Claude Desktop and claude.ai reach it from Anthropic's servers, so they can't reach one running on your own computer.

## 1. Turn on Managed OAuth

Managed OAuth lets an app such as Claude act with a person's account, the way the editor does in their browser. Cloudflare marks it as beta, and its [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) page describes it.

1. In **Zero Trust**, go to **Access controls → Applications**, and select **Edit** on your application.

1. On the **Additional settings** tab, select the **OAuth** filter, and find **Managed OAuth (Beta)**.

1. Turn on **Managed OAuth**.

1. Turn on **Allow localhost clients** and **Allow loopback clients**. Claude Code receives the person's approval on their own computer, at a `localhost` or `127.0.0.1` address.

1. Under **Allowed redirect URIs**, add Claude's address, so Claude Desktop and claude.ai can connect:

    ```
    https://claude.ai/api/mcp/auth_callback
    ```

    Access accepts Claude only with an address listed here. Leave it out if no one will connect Claude Desktop or claude.ai.

1. Set the **Grant session duration** to 1 week. A connection renews itself while it's in use until this ends, and then Claude asks the person to approve it again. Cloudflare recommends one to two weeks for a command-line tool.

1. Save the application.

1. Check that a request with no sign-in now says where an app signs in:

    ```bash
    curl -si https://newsletter.example.com/api/whoami
    ```

    It answers `401`, and its `www-authenticate` line starts with `Bearer` and names `resource_metadata`. Without Managed OAuth, Cloudflare answers with a redirect to its login page instead. A browser still gets the login page either way.

## 2. Connect Claude, or send the publisher the address

The publisher connects at the instance's address followed by `/api/mcp`:

```
https://newsletter.example.com/api/mcp
```

If you're the publisher, connect now, as [Connect Claude](../publishing/08-connect-claude.md) describes. If someone else is, send them that address and a link to the same page.

## Who can connect

Anyone the `Publishers` policy lets into the dashboard can connect Claude, since they sign in the same way. To stop someone connecting, remove them from that policy. If you set `ACCESS_ALLOWED_EMAILS`, store the list again without them: the app checks it on every request, so it takes effect at once.

## Check it

1. Connect Claude Desktop or claude.ai, as [Connect Claude](../publishing/08-connect-claude.md) describes. The connector lists Kestrel's tools, such as **Get the publication** and **Save a draft**.

1. Ask Claude what the publication is called. It answers with the name the dashboard shows.

If Claude can't connect, [Claude can't connect](../publishing/06-troubleshooting.md#claude-cant-connect) lists what it reports and the fix.
