# Automate with a service token

A service token lets a script or scheduled job call the API, such as a job that drafts a weekly digest. Kestrel labels these changes **a service token**, rather than with a person's name.

In this guide, you create a service token, allow it in through the Access application, give it to your script, and check that it works. To connect Claude as yourself instead, follow [Allow Claude to connect](01-allow-claude.md).

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

## 2. Allow the token in

The application lets in only the people its `Publishers` policy names, so the token needs a policy of its own on the same application.

1. Under **Access controls → Applications**, select **Configure** on the application from [Lock the dashboard with Access](../get-started/03-access.md#2-create-the-access-application).

1. Add a policy:

    - **Policy name:** `Automation`
    - **Action:** Service Auth
    - **Include:** the **Service Token** selector, with your token

1. Save the application.

This policy is the only thing that lets the token in. `ACCESS_ALLOWED_EMAILS` doesn't apply to it, since it has no email.

## 3. Give the token to your script

The script sends the two values as headers on every request: `CF-Access-Client-Id` with the Client ID, and `CF-Access-Client-Secret` with the Client Secret.

1. Store the Client ID and the Client Secret where your script reads secrets, such as its environment, your CI's secrets, or a password manager. Never commit the secret to a repository.

1. Have the script send both headers with every request to `https://newsletter.example.com/api/…`. For example, this request saves a new draft:

    ```bash
    curl -s https://newsletter.example.com/api/posts \
      -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
      -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"subject":"Weekly digest","markdown":"# This week\n\nThree things worth reading."}'
    ```

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

If the script gets a `401`, a `403`, or a login page, check the policy from section 2, and the token's two values. The policy's action must be Service Auth, since the app refuses a login through any other kind of policy with a `401` whose `reason` is `access_unidentified`. Check that the token hasn't expired, too.

## Renew or revoke a token

A service token stops working when its duration ends. Before then, extend it on the token under **Access controls → Service credentials → Service Tokens**, or create a new token, add it to the `Automation` policy, give it to the script, and then delete the old one.

To stop a script at once, delete its token there. Its next request is refused.

## More information

The API reference describes every route: its method and path, the body it takes, its refusals, and an example. The editor's **API** tab shows it, and a program reads it as Markdown: `GET /api/reference.md` is the index, and `GET /api/reference/<resource>.md` holds one resource's routes in full. `GET /api/openapi.json` is the same reference as an OpenAPI 3.1 document, for a tool that imports one.
