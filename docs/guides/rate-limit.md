# Rate-limit the subscribe form

The subscribe form is public, so anyone can submit it, as often as they like. The app already sends any one address at most one confirmation every 15 minutes, and answers every address the same way. It can't tell one visitor from another, though. Cloudflare can, so a rule at Cloudflare caps how often each visitor submits.

In this guide, you add a rate-limiting rule for the subscribe page, and check that it blocks a burst of requests. Nothing changes in the app.

## 1. Add a rate-limiting rule

Cloudflare's Free plan includes one rate-limiting rule, and the subscribe form is a good place to spend it.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open your domain, `example.com`, and go to **Security rules**.

1. Select **Create rule**, then **Rate limiting rules**.

1. Fill in the rule:

    - **Rule name:** `Subscribe form`
    - **If incoming requests match:** **URI Path** equals `/subscribe`
    - **With the same characteristics:** IP
    - **When rate exceeds:** 5 requests per 10 seconds
    - **Then take action:** Block, with a duration of 10 seconds

    The rule's expression reads:

    ```
    (http.request.uri.path eq "/subscribe")
    ```

1. Select **Deploy**.

On the Free plan, a rule can match only on the path. It counts loads of the form as well as submissions, and `/subscribe` on every hostname in your domain. At five requests in 10 seconds, neither gets in a real reader's way.

A paid plan allows a longer window, which fits a form better. On Pro, try 10 requests a minute, blocked for 10 minutes. Pro can also limit the rule to the app's hostname, with `and http.host eq "newsletter.example.com"`. Business can limit it to submissions, with `and http.request.method eq "POST"`.

The rule covers only your domain's hostnames. The Worker's `workers.dev` addresses would skip it, which is why your production settings keep `workers_dev` and `preview_urls` set to `false`. Keep them that way.

## Check it

1. Request the subscribe page eight times in a row:

    ```bash
    for i in $(seq 1 8); do curl -s -o /dev/null -w "%{http_code}\n" https://newsletter.example.com/subscribe; done
    ```

    The first requests answer `200`. Once you pass five within 10 seconds, the rest answer `429`, Cloudflare's block. The switch can come a request or two later.

1. Wait 10 seconds, and open `https://newsletter.example.com/subscribe` in a browser. The form loads again.

1. In the dashboard, **Security rules** lists `Subscribe form` as active.
