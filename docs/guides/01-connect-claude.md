# Connect automation to the API

A script or a scheduled job can call the same API the editor uses, with no one signed in. It uses a Cloudflare Access service token, so its changes show as a service token's, never a person's. Anything it schedules waits out the review window, where the publisher can still cancel it.

Claude doesn't need this. It signs in as the publisher: Claude Code with `kestrel login`, as [Connect Claude Code](../publishing/07-working-with-claude.md#connect-claude-code) describes, and Claude Desktop and claude.ai as a custom connector, as [Connect Claude Desktop or claude.ai](../publishing/07-working-with-claude.md#connect-claude-desktop-or-claudeai) describes, so its changes show as theirs, via Claude. Use a service token only for a program that runs when no one is there.

In this guide, you create a service token, and add a policy for it to your Access application. Then you give the token to your script, check that it works, and point the script at the API reference.

## Before you begin

You need:

- The dashboard locked with Access, from [Lock the dashboard with Access](../get-started/03-access.md).
- The script or job that will call the API, and somewhere it keeps secrets.

## 1. Create a service token

A service token is a Client ID and a Client Secret that a program sends with each request. It carries no email, so the app tells it apart from a person's sign-in.

1. In **Zero Trust**, go to **Access controls → Service credentials → Service Tokens**, and select **Create Service Token**.

1. Name it for what will use it, such as `kestrel-automation`, and choose a **Service Token Duration**. A year is a good default.

1. Select **Generate token**.

1. Copy the **Client ID** and the **Client Secret**. Cloudflare shows the secret only once.

## 2. Add a policy for the token

Your application lets in only the people its `Publishers` policy names. A token needs a policy of its own, on the same application, because the app accepts only logins issued for that application.

1. Under **Access controls → Applications**, select **Configure** on the application from [Lock the dashboard with Access](../get-started/03-access.md#2-create-the-access-application).

1. Add a policy:

    - **Policy name:** `Automation`
    - **Action:** Service Auth
    - **Include:** the **Service Token** selector, with your token

1. Save the application.

`ACCESS_ALLOWED_EMAILS` doesn't apply to the token, since it has no email. This policy is the only thing that lets it in.

The app accepts only this kind of policy and the `Publishers` one, an Allow policy on emails. A login through any other kind of policy carries neither an email nor a token's Client ID, and the app refuses it with a `401` whose `reason` is `access_unidentified`.

## 3. Give the token to your script

The script sends the two values as headers on every request: `CF-Access-Client-Id` with the Client ID, and `CF-Access-Client-Secret` with the Client Secret.

1. Store the Client ID and the Client Secret where your script reads secrets, such as its environment, your CI's secrets, or a password manager.

1. Have the script send both headers with every request to `https://newsletter.example.com/api/…`.

Never commit the secret to a repository, and never put it in `.claude/settings.json`.

## 4. Point the script at the API

The API reference describes every route: its method and path, the body it takes, its refusals, and an example. The editor's **API** tab shows the same reference.

For a program, the reference is Markdown in two levels: `GET /api/reference.md` is the index, with what every route shares and each route on one line, and `GET /api/reference/<resource>.md` holds one resource's routes in full. The JSON at `GET /api/reference` is the whole reference in one answer, as the editor reads it, and `GET /api/openapi.json` is the same reference as an OpenAPI 3.1 document, for a tool that imports one. The docs are served as Markdown too: `GET /api/docs/publishing.md` lists the publisher's pages, `GET /api/docs/self-hosting.md` this guide's, and each page is at `GET /api/docs/<slug>.md`.

An agent given only your app's address finds these routes too. `GET /llms.txt` is public. It names the publication, its archive and subscribe page, and the reference and docs indexes, and links the ways to sign in.

The reference lists the body types each route takes. Most take JSON, sent with `Content-Type: application/json`. An image upload takes a multipart form, or the image file itself.

A service token is held to everything Claude is, and more. An import it commits is emailed to the publisher, if notifications are set, since no one saw it happen. An import that would grow a scheduled send is refused, until the publisher finishes it in the dashboard.

## Check it

1. Call `GET /api/whoami` with the two headers. The app answers with a program's identity, not a person's:

    ```bash
    curl -s https://newsletter.example.com/api/whoami \
      -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
      -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
    ```

    ```
    {"principal":{"kind":"service","token_id":"e367c0ffee5eb4.access","client":null},"auth":{"mode":"access"}}
    ```

    The `token_id` is the Client ID Zero Trust shows beside your token. If it's a different one, the script is using another token.

1. Call `GET /api/posts`. It answers with the posts the editor shows.

1. Open a draft in the editor, and have the script save a change to it. The editor shows that the draft was changed elsewhere, last edited by **a service token**.

If the script gets a `401`, a `403`, or a login page, check the policy from section 2, and the token's two values. The policy's action must be Service Auth. Check that the token hasn't expired, too.
