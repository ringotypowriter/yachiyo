---
title: Web search and reading
description: Choose a search provider, bootstrap the hidden browser session, and understand how webRead extracts pages.
---

Yachiyo has three web-facing tools, and they do different jobs:

- **`webSearch`** — run a query, get results.
- **`webRead`** — fetch a URL and return readable content.
- **`useBrowser`** — drive a real browser for things a fetch cannot do: logins,
  JS-heavy apps, multi-step flows.

Configure the first two in **Settings → Sources → Search**.

## Search providers

| Provider                 | How it works                                    | Needs   |
| ------------------------ | ----------------------------------------------- | ------- |
| **Google (browser)**     | Queries Google through a hidden browser session | nothing |
| **DuckDuckGo (browser)** | Same, against DuckDuckGo                        | nothing |
| **Exa**                  | The [Exa](https://exa.ai) search API            | API key |

Google via the hidden browser is the default. The browser-backed providers need
no account and no key, at the cost of occasionally hitting consent walls or bot
checks.

## The hidden browser session

The browser-backed providers run in their own session, separate from your normal
browsing. A fresh session has no cookies, which is exactly when Google decides
you look like a robot.

The fix is a one-time import: **Settings → Sources → Search → Browser Session →
Import from Chrome**. Pick a Chrome profile and Yachiyo copies its cookies and
consent state into the search session. The pane shows when the last import
happened and which profile it came from.

Re-import if search results start coming back empty or you begin seeing consent
interstitials again.

## Reading pages

`webRead` fetches a URL and gives back the readable part, in whatever format was
requested. What happens depends on what comes back:

| Response                         | Behavior                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- |
| HTML                             | Main content extracted with [Defuddle](https://github.com/kepano/defuddle) |
| PDF                              | Text extracted automatically                                               |
| Plain text, JSON, other non-HTML | Returned raw                                                               |
| HTML where extraction fails      | Falls back to the raw response body                                        |

If the content is too large to return inline, it is written to a workspace file
and the agent reads it from there instead of blowing out the context window.

`webRead` is for static fetches. Login flows, JavaScript apps, and anything
needing interaction are `useBrowser` territory — and the bundled
`yachiyo-browser` skill covers how to drive it well.

## Exa

Exa is an API rather than a scrape, which makes it more reliable and more
predictable — worth it if you search heavily. Add the key in **Settings →
Sources → Search**, or:

```bash
yachiyo config set webSearch.defaultProvider '"exa"'
yachiyo config set webSearch.exa.apiKey '"your-exa-api-key"'
```

A custom `webSearch.exa.baseUrl` is supported for self-hosted or proxied
endpoints.
