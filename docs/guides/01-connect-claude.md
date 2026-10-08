# Connect Claude to the API

Claude Code can draft, edit, proofread, and schedule your posts through the same API the editor uses. It has its own Cloudflare Access credential, so its changes show as Claude's, not yours. Anything it schedules waits out the review window, where you can still cancel it.

In this guide, you create a service token for Claude Code, and add a policy for it to your Access application. Then you store the token where Claude Code reads it, check that it works, and point Claude at the API reference.

## Before you begin

You need:

- The dashboard locked with Access, from [Lock the dashboard with Access](../get-started/03-access.md).
- [Claude Code](https://code.claude.com/docs/en/overview), run from your copy of the repository.

## 1. Create a service token

A service token is a Client ID and a Client Secret that a program sends with each request. It carries no email, so the app tells it apart from your own login.

1. In **Zero Trust**, go to **Access controls → Service credentials → Service Tokens**, and select **Create Service Token**.

1. Name it `kestrel-claude`, and choose a **Service Token Duration**. A year is a good default.

1. Select **Generate token**.

1. Copy the **Client ID** and the **Client Secret**. Cloudflare shows the secret only once.


## 2. Add a policy for the token

Your application lets in only the people its `Publishers` policy names. A token needs a policy of its own, on the same application, because the app accepts only logins issued for that application.

1. Under **Access controls → Applications**, select **Configure** on the application from [Lock the dashboard with Access](../get-started/03-access.md#2-create-the-access-application).

1. Add a policy:

    - **Policy name:** `Claude`
    - **Action:** Service Auth
    - **Include:** the **Service Token** selector, with `kestrel-claude`

1. Save the application.

`ACCESS_ALLOWED_EMAILS` doesn't apply to the token, since it has no email. This policy is the only thing that lets it in.

## 3. Store the token for Claude Code

Claude Code loads the `env` block of `.claude/settings.local.json` into every session. That file stays on your computer: your repository's `.gitignore` keeps it out of git.

1. Open `.claude/settings.local.json` in your copy of the repository. Create it if it doesn't exist.

1. Add an `env` block, beside anything already in the file:

    ```json
    {
      "env": {
        "KESTREL_URL": "https://newsletter.example.com",
        "CF_ACCESS_CLIENT_ID": "REPLACE_WITH_CLIENT_ID",
        "CF_ACCESS_CLIENT_SECRET": "REPLACE_WITH_CLIENT_SECRET"
      }
    }
    ```

    `KESTREL_URL` is your app's address. The other two are the Client ID and Client Secret from section 1.

1. Start a new Claude Code session, so it loads the values.

Never put the secret in `.claude/settings.json`. That file is committed.

## 4. Point Claude at the API

Kestrel has no plugin or connector for Claude. Claude calls the HTTP API directly, and the API reference describes every route: its method and path, the body it takes, and an example. The editor's **API** tab shows the same reference.

Start a session with a prompt like this one:

```
Kestrel's API is at $KESTREL_URL. Send the CF-Access-Client-Id and
CF-Access-Client-Secret headers from your environment with every request.
Read GET /api/reference first, and use it for every call.
```

Claude reads the reference, and from there can list your posts, write a draft, and schedule it. A request that sends a body needs `Content-Type: application/json`, and the reference says so for each route.

## Check it

1. Ask Claude to call `GET /api/whoami`. The app answers with a program's identity, not yours:

    ```
    {"principal":{"kind":"service"},"auth":{"mode":"access"}}
    ```

1. Ask Claude to list your posts. It answers with the posts the editor shows.

1. Open a draft in the editor, and ask Claude to change a word in it. The editor shows that the draft was changed elsewhere, last edited by **Claude**.

If Claude gets a `401`, a `403`, or a login page, check the policy from section 2, and the token's two values in `.claude/settings.local.json`. Check that the token hasn't expired, too.
