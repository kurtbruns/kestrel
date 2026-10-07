# Put the archive on your website

Every post you send has a permanent web address, its archive link. Each email's **View in browser** link points there, and so does every link a reader shares. By default the archive lives on the app's hostname, at `newsletter.example.com/archive/`. This guide moves it to your main website, at `example.com/archive/`, so your links carry the domain readers already know.

In this guide, you route your website's archive path to the app, and point archive links at your website. Optionally, you also serve images from a hostname of their own. The app itself, with the editor, the API, and the subscribe pages, stays on `newsletter.example.com`.

## Before you begin

You need:

- Your website on Cloudflare, in the same account as the app, with its DNS record proxied. A site on Cloudflare Pages or Workers is proxied already. If your site isn't on Cloudflare, keep the archive on the app's hostname, a permanent home for your posts.
- A path prefix for the archive that no page on your site starts with. These steps use `/archive`, the default.

It's recommended to make this change before your first send. Links you've already mailed keep working, because the app still answers on its own hostname. They just keep pointing there.

## 1. Route your website's archive path to the app

A Worker route sends the requests for one path on your website to the app. Your website keeps every other path. The route goes in `wrangler.jsonc`, not the dashboard. Each deploy replaces the Worker's routes with the ones in the file, so a route added in the dashboard disappears.

1. In `wrangler.jsonc`, in the `production` block, add a second entry to `routes`:

    ```jsonc
    "routes": [
      { "pattern": "newsletter.example.com", "custom_domain": true },
      { "pattern": "example.com/archive*", "zone_name": "example.com" } // ← your website's domain
    ],
    ```

    The pattern ends in `*` with no slash before it, so it matches the archive index at `/archive` as well as every post under it. It also matches any other path that starts with `/archive`, such as `/archives`, and the app answers those with a "not found" page. That's why the prefix must be one your site doesn't use.

1. If you chose another prefix, use it in the pattern, and set `ARCHIVE_BASE_PATH` to the same value. The app serves the archive at that path, and builds every archive link from it.

## 2. Point archive links at your website

The app builds every archive link from `ARCHIVE_ORIGIN`. It defaults to the app's own hostname.

1. In the `production` block's `vars`, add `ARCHIVE_ORIGIN`:

    ```jsonc
    "ARCHIVE_ORIGIN": "https://example.com", // ← your website
    ```

1. Commit the change, and push it:

    ```bash
    git commit -am "Put the archive on example.com"
    git push
    ```

1. Deploy:

    ```bash
    npm run deploy -- --env production
    ```

    The output lists both routes: your app's hostname, and `example.com/archive*`.

## 3. (Optional) Serve images from their own hostname

By default, images load from the app, at `newsletter.example.com/media/`. You can serve them straight from the R2 bucket on a hostname of their own, such as `media.example.com`. The app works the same either way.

1. In the Cloudflare dashboard, go to **R2 object storage**, and select `kestrel-media-production`.

1. Under **Settings → Custom Domains**, select **Add**. Enter `media.example.com`, select **Continue**, and then **Connect Domain**. Wait until its status is **Active**.

1. Add two security headers to that hostname. The app's own `/media` path sends them with every image, so a file in the bucket can never run as a page. A bucket's custom domain sends neither. In your domain's **Rules → Overview**, select **Create rule**, then **Response Header Transform Rule**:

    - **Rule name:** `Media security headers`
    - **When incoming requests match:** a custom filter, with **Hostname** equal to `media.example.com`
    - **Modify response header:** **Set static** `Content-Security-Policy` to `sandbox`
    - **Set new header:** **Set static** `X-Content-Type-Options` to `nosniff`

    Select **Deploy**.

1. In the `production` block's `vars`, add `MEDIA_PUBLIC_BASE`:

    ```jsonc
    "MEDIA_PUBLIC_BASE": "https://media.example.com",
    ```

1. Commit, push, and deploy, as in section 2.

Sends you schedule from now on use the new address. Emails scheduled before keep loading images from the app, which still serves them.

## Check it

1. Your website still answers on its own pages:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" https://example.com/
    ```

    ```
    200
    ```

1. The archive answers on your website:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" https://example.com/archive
    ```

    ```
    200
    ```

    In a browser, `https://example.com/archive` shows your publication's name, and the posts you've sent.

1. In the editor, **Settings → Instance** shows **Archive URL base** as `https://example.com/archive`.

1. Send yourself a test email. Its **View in browser** link starts with `https://example.com/archive/`.

1. If you did section 3, `curl -sI` on an image's URL shows `content-security-policy: sandbox` and `x-content-type-options: nosniff`.

If your website runs on Cloudflare Pages, check the archive in a browser as well. Cloudflare doesn't document how a Worker route and a Pages project share a hostname.
