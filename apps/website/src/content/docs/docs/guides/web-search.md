---
title: Web search and reading
description: Understand automatic search fallback, bootstrap the hidden browser session, and configure Exa.
---

Yachiyo has three web-facing tools, and they do different jobs:

- **`webSearch`** — run a query and get normalized organic results.
- **`webRead`** — fetch a URL and return readable content.
- **`useBrowser`** — drive a real browser for things a fetch cannot do: logins,
  JS-heavy apps, and multi-step flows.

Search settings manage the hidden browser session and optional Exa access.

## Automatic search providers

| Provider                 | How it works                                    | Needs   |
| ------------------------ | ----------------------------------------------- | ------- |
| **Bing (browser)**       | Queries Bing through a hidden browser session   | nothing |
| **Google (browser)**     | Queries Google through a hidden browser session | nothing |
| **Brave (browser)**      | Queries Brave through a hidden browser session  | nothing |
| **DuckDuckGo (browser)** | Queries DuckDuckGo through a hidden browser     | nothing |
| **Exa**                  | Uses the [Exa](https://exa.ai) search API       | API key |

You do not select one provider. Yachiyo scores the providers using recent health,
latency, current load, and idle time, then starts with the best available candidate.
If that provider times out, fails to load, cannot extract results, or presents a bot
challenge, the same search falls back to another provider. Failed providers cool down
before Yachiyo tries them again.

The four browser providers are available without accounts or API keys. Exa joins the
candidate pool automatically when its API key is configured.

## The hidden browser session

The browser-backed providers share a dedicated session, separate from your normal
browsing. A fresh session has no cookies, which can make search sites present consent
walls or bot checks more often.

Import once from **Settings → Sources → Search → Browser Session → Import from Chrome**.
Pick a Chrome profile and Yachiyo copies its cookies and consent state into the search
session. The pane shows when the last import happened and which profile it came from.

Re-import if browser providers begin hitting consent interstitials or challenges more
often.

## Reading pages

`webRead` fetches a URL and gives back the readable part in the requested format:

| Response                         | Behavior                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- |
| HTML                             | Main content extracted with [Defuddle](https://github.com/kepano/defuddle) |
| PDF                              | Text extracted automatically                                               |
| Plain text, JSON, other non-HTML | Returned raw                                                               |
| HTML where extraction fails      | Falls back to the raw response body                                        |

If the content is too large to return inline, Yachiyo writes it to a workspace file and
reads it from there instead of filling the context window.

`webRead` is for static fetches. Login flows, JavaScript apps, and anything needing
interaction are `useBrowser` territory; the bundled `yachiyo-browser` skill covers that
workflow.

## Exa

Exa uses an API rather than a browser page, so it is usually more predictable. Add the
key in **Settings → Sources → Search**, or run:

```bash
yachiyo config set webSearch.exa.apiKey '"your-exa-api-key"'
```

Yachiyo adds Exa to automatic selection as soon as the key is present. A custom
`webSearch.exa.baseUrl` is supported for self-hosted or proxied endpoints.
