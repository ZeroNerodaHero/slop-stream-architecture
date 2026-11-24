# Cloudflare Turnstile

A human check on the three ways an account is made or entered with a password: `POST /api/signup`,
`POST /api/login`, and the oauth name pick `POST /api/oauth/signup`. Off by default. On top of
the api's own limits (rate-limits.md), not instead of them.

- **api**: `api/src/turnstile.rs`. `verify` runs before argon2 and the signup/login counters, so a
  bot with no token spends neither. While on, a missing or bad token is a `403` (`human check
  missing. try again` / `human check failed. try again`), and so is a siteverify that could not
  be reached: it fails closed.
- **pages**: `frontend/src/shared-components/Turnstile.tsx`. Asks `GET /api/config/turnstile`
  (`{enabled, siteKey}`, never the secret) once per page load. Off: draws nothing, loads no
  script, the forms work as before. On: loads Cloudflare's script once, renders the widget in the
  log in / sign up dialog (`AuthForm.tsx`), the security tab's form (`SecurityTab.tsx`) and the
  name pick (`OAuthPage.tsx`), and keeps the submit disabled until it has a token. The token goes
  in the body as `turnstile_token`; it is single-use, so the widget resets after every submit.
- **Not gated**: `GET /api/oauth/{provider}/start` and `/callback`. They are redirects the browser
  is sent through, with no page to draw a widget on, and no account exists until the name pick,
  which is gated. A login with a provider already linked is the provider's check.

## 1. The widget

Cloudflare dashboard, **Turnstile**, **Add widget**:

- name: `nodentity`
- hostnames: `nodentity.xyz` (add `localhost` only on a separate test widget, never on prod's)
- widget mode: **Managed**
- pre-clearance: no

It shows a **site key** (public, goes to the pages) and a **secret key** (the api's alone).

## 2. Turn it on

In the box's `.env` (`.env.example` has the three, compose passes them to the api):

```
TURNSTILE_ENABLED=true
TURNSTILE_SITE_KEY=<site key>
TURNSTILE_SECRET=<secret key>
```

Then restart the api: `docker compose up -d api`. Config is read once at boot. The log says
`turnstile: on for signup and login`. `TURNSTILE_ENABLED=true` with either key empty logs an
error and stays off; nothing crashes.

Check: `curl https://nodentity.xyz/api/config/turnstile` answers `{"enabled":true,"siteKey":"..."}`,
and the log in dialog shows the widget.

The pages load `https://challenges.cloudflare.com/turnstile/v0/api.js` and frame
`challenges.cloudflare.com`. A Content-Security-Policy added later must allow both
(`script-src` and `frame-src`). A browser blocking that host gets a line under the form saying the
check did not load, and cannot log in while it is on.

## 3. One rate limiting rule (Free plan)

The Free plan has **one** rate limiting rule. It is for the two password routes. Dashboard:
**Security**, **WAF**, **Rate limiting rules**, **Create rule**:

- name: `login and signup`
- if incoming requests match: field **URI Path**, operator **is in**, value `/api/login`, `/api/signup`
  (expression: `(http.request.uri.path in {"/api/login" "/api/signup"})`)
- with the same characteristics: **IP** (the only one on Free)
- when rate exceeds: requests `10` (a starting point; a person needs two or three), period **10 seconds** (the only one on Free)
- then take action: **Managed Challenge**
- duration: **10 seconds** (the only one on Free)

Free plan limits, at the time of writing (check the dashboard; Cloudflare changes them): one
rule, the URI path field only in the expression, IP as the only characteristic, a 10 second
period and a 10 second mitigation timeout.

A challenge on these routes lands on a `fetch` from the page, not a page load, so the browser
cannot solve it: the form shows `http 403` until the 10 seconds are up. That is the intent, a
burst stops; a person who hits it waits and tries again. If real people hit it, raise the count
before changing the action.

## Testing

Cloudflare's test keys, for a dev box or a test widget (any hostname, `localhost` included):

| key | value | does |
|---|---|---|
| site key | `1x00000000000000000000AA` | always passes, visible widget |
| secret | `1x0000000000000000000000000000000AA` | siteverify always passes |
| secret | `2x0000000000000000000000000000000AA` | siteverify always fails |

With the passing pair: log in and sign up work, and a `curl` with no `turnstile_token` gets
`403 human check missing. try again`. Swap in the failing secret and restart the api: every
log in and sign up gets `403 human check failed. try again`. `cargo test turnstile` covers the
config parsing, the public config never carrying the secret, the siteverify answer and the token
bounds.

## Rollback

1. `TURNSTILE_ENABLED=false` in `.env`, then `docker compose up -d api`. The api stops asking for
   a token, `/api/config/turnstile` says off, and the pages stop drawing the widget on their next
   load. No page deploy needed; a page already open sends a token the api ignores.
2. Delete the rate limiting rule: **Security**, **WAF**, **Rate limiting rules**, the rule's
   menu, **Delete**.

The widget in the Turnstile dashboard can stay; nothing uses it while off.
