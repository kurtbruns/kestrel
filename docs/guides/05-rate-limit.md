# Rate-limit the subscribe form

The subscribe form is public, so it is worth capping how often one visitor can submit it. The app already sends any one address at most one confirmation every 15 minutes, and answers every address the same way (`docs/SPEC.md` §7). A cap per visitor is the edge's job, because the edge can tell visitors apart and the app cannot, so there is nothing in the app to configure.

## Add the rule

In the Cloudflare dashboard, open the zone for `newsletter.example.com`, then **Security rules → Create rule → Rate limiting rules**:

- **If incoming requests match:** a custom expression on the path,

  ```
  (http.request.uri.path eq "/subscribe")
  ```

  On the Free and Pro plans a rate-limiting rule can match only on the path, so this also counts loads of the form page, which is harmless at this rate. On Business and above you can narrow it to submissions with `and http.request.method eq "POST"`.
- **With the same characteristics:** IP.
- **When rate exceeds:** 5 requests per 10 seconds. That is the Free plan's only period; on a paid plan a longer one fits the form better, such as 10 requests per minute.
- **Then take action:** Block, for the shortest duration the plan offers (10 seconds on Free).

The Free plan allows one rate-limiting rule, and this is the one to spend it on.

The rule applies only on the zone's own hostname. The template's `"workers_dev": false` and `"preview_urls": false` keep the Worker off its `*.workers.dev` addresses, where a request would skip the rule; keep them that way.

## Check it

- [ ] Submit the form rapidly from one machine: after the limit, Cloudflare answers with its own block page instead of the app's.
