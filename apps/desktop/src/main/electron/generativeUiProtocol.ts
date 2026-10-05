import electron from 'electron'
import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import { themeRgbTokenVars } from '@yachiyo/shared/theme/themePalettes'

const { protocol } = electron

export const GENERATIVE_UI_SCHEME = 'yachiyo-ui'
export const GENERATIVE_UI_URL = 'yachiyo-ui://sandbox/'

/** Never resolve a request URL to disk, even when it resembles an asset path. */
export function isGenerativeUiShellUrl(url: string): boolean {
  return url === GENERATIVE_UI_URL
}

export function isGenerativeUiFrameUrl(url: string | undefined): boolean {
  return url?.startsWith(`${GENERATIVE_UI_SCHEME}:`) ?? false
}

function isGenerativeUiFrame(frame: Electron.WebFrameMain | null | undefined): boolean {
  while (frame) {
    if (isGenerativeUiFrameUrl(frame.url)) return true
    frame = frame.parent
  }
  return false
}

/** Self-contained because this validator is also embedded in the fixed sandbox shell. */
export function normalizeGenerativeUiThemeVars(
  value: unknown,
  rgbVariables: readonly string[] = Object.values(themeRgbTokenVars)
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const colors = new Set(rgbVariables)
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.length > 200) continue
    if (key === '--yachiyo-font-ui') {
      if (raw.trim() && !/[;{}<>\r\n]/.test(raw)) result[key] = raw
    } else if (colors.has(key)) {
      const channels = raw.trim().split(/\s+/)
      if (
        channels.length === 3 &&
        channels.every((channel) => /^\d{1,3}$/.test(channel) && Number(channel) <= 255)
      )
        result[key] = raw.trim()
    }
  }
  return result
}

export function registerGenerativeUiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GENERATIVE_UI_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false }
    }
  ])
}

export function buildGenerativeUiShell(): { html: string; csp: string } {
  const nonce = randomBytes(24).toString('base64')
  const csp = [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts'
  ].join('; ')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;min-height:1px}*{box-sizing:border-box}
html{--yachiyo-rgb-ink:45 45 43;--yachiyo-rgb-surface:255 255 255;--yachiyo-rgb-text-muted:142 142 147;--yachiyo-rgb-accent:75 175 201;--yachiyo-rgb-accent-strong:42 122 149;--yachiyo-font-ui:'Avenir Next','Helvetica Neue','Segoe UI',sans-serif;color-scheme:light}
html[data-theme=dark]{--yachiyo-rgb-ink:238 241 242;--yachiyo-rgb-surface:38 42 46;--yachiyo-rgb-text-muted:123 134 140;color-scheme:dark}
body{font:14px/1.6 var(--yachiyo-font-ui);padding:0;overflow-wrap:anywhere;color:rgb(var(--yachiyo-rgb-ink));background:transparent}
button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;border:1px solid rgb(var(--yachiyo-rgb-ink)/.1);border-radius:8px;background:rgb(var(--yachiyo-rgb-ink)/.04);padding:6px 12px}button:hover{background:rgb(var(--yachiyo-rgb-ink)/.08)}input,select,textarea{max-width:100%;border:1px solid rgb(var(--yachiyo-rgb-ink)/.12);border-radius:8px;background:transparent;padding:6px 10px}a{color:rgb(var(--yachiyo-rgb-accent-strong))}:focus-visible{outline:2px solid rgb(var(--yachiyo-rgb-accent));outline-offset:2px}h1,h2,h3{font-weight:600;line-height:1.35;margin:0 0 12px}p{margin:8px 0}img,canvas,svg{max-width:100%}#content{display:flow-root;min-height:1px}
</style>
</head><body class="light"><div id="content"></div><script nonce="${nonce}">
(() => {
  'use strict';
  const content = document.getElementById('content');
  const normalizeThemeVars = ${normalizeGenerativeUiThemeVars.toString()};
  const style = document.createElement('style');
  document.head.appendChild(style);
  let port = null;
  let executed = false;
  let previousHtml = null;
  let previousCss = null;
  const allowedTags = new Set('a abbr address article aside b bdi bdo blockquote br button canvas caption cite code col colgroup data datalist dd del details dfn div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img input kbd label legend li main mark meter nav ol optgroup option output p pre progress q rp rt ruby s samp section select small span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr'.split(' '));
  const svgTags = new Set('svg g path circle ellipse rect line polyline polygon text tspan defs linearGradient radialGradient stop clipPath'.split(' '));
  const svgAttrs = new Set('viewbox xmlns d fill stroke stroke-width stroke-linecap stroke-linejoin fill-rule opacity cx cy r rx ry x x1 x2 y y1 y2 width height points transform offset stop-color stop-opacity preserveaspectratio class id'.split(' '));
  const allowedAttrs = new Set('alt autocomplete checked class cols colspan datetime dir disabled for height hidden id lang list max maxlength min minlength multiple name open placeholder readonly required role rows rowspan selected size span start step tabindex title type value width'.split(' '));
  const imageUrl = (value) => /^data:image\\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value);
  const linkUrl = (value) => {
    try { return ['https:', 'http:'].includes(new URL(value).protocol); }
    catch { return false; }
  };
  const send = (message) => { if (port) port.postMessage(message); };
  const api = Object.freeze({
    reportHeight(height) {
      if (typeof height === 'number' && Number.isFinite(height) && height >= 0) send({ type: 'height', height });
    },
    openLink(url) {
      if (typeof url === 'string' && linkUrl(url)) send({ type: 'openLink', url });
    },
    continueConversation(text) {
      if (typeof text === 'string' && text.trim()) send({ type: 'continueConversation', text });
    }
  });
  Object.defineProperty(window, 'yachiyoUi', { value: api, configurable: false, writable: false });
  function sanitize(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const result = document.createDocumentFragment();
    function copy(source, target) {
      for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { target.appendChild(document.createTextNode(child.textContent)); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.localName;
        const svg = child.namespaceURI === 'http://www.w3.org/2000/svg';
        if (svg ? !svgTags.has(tag) : child.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowedTags.has(tag)) continue;
        const safe = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
        for (const attr of child.attributes) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'srcdoc') continue;
          if (svg) { if (svgAttrs.has(name)) safe.setAttribute(attr.name, attr.value); continue; }
          if (name === 'style' || allowedAttrs.has(name) || name.startsWith('aria-') || name.startsWith('data-')) safe.setAttribute(name, attr.value);
          if (name === 'href' && tag === 'a' && linkUrl(attr.value)) safe.setAttribute('href', attr.value);
          if (name === 'src' && tag === 'img' && imageUrl(attr.value)) safe.setAttribute('src', attr.value);
        }
        target.appendChild(safe);
        copy(child, safe);
      }
    }
    copy(parsed.body, result);
    return result;
  }
  function reportHeight() { api.reportHeight(Math.ceil(Math.max(content.getBoundingClientRect().height, content.scrollHeight))); }
  new ResizeObserver(reportHeight).observe(document.body);
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) api.openLink(href);
  }, true);
  window.addEventListener('error', (event) => send({ type: 'error', message: String(event.message) }));
  window.addEventListener('unhandledrejection', (event) => send({ type: 'error', message: String(event.reason) }));
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || port || event.data?.type !== 'yachiyo-ui-connect' || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (!data || data.type !== 'render') return;
      try {
        const title = typeof data.title === 'string' ? data.title : '';
        const html = typeof data.html === 'string' ? data.html : '';
        const css = typeof data.css === 'string' ? data.css : '';
        document.title = title;
        document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
        for (const [key, value] of Object.entries(normalizeThemeVars(data.themeVars, ${JSON.stringify(Object.values(themeRgbTokenVars))}))) document.documentElement.style.setProperty(key, value);
        if (!executed && html !== previousHtml) {
          content.replaceChildren(sanitize(html));
          previousHtml = html;
        }
        if (!executed && css !== previousCss) {
          style.textContent = css;
          previousCss = css;
        }
        reportHeight();
        if (data.completed === true && !executed) {
          executed = true;
          if (typeof data.js === 'string' && data.js.trim()) {
            const script = document.createElement('script');
            script.nonce = '${nonce}';
            script.textContent = data.js;
            document.body.appendChild(script);
            script.remove();
          }
        }
      } catch (error) { send({ type: 'error', message: String(error) }); }
    };
    port.start();
    reportHeight();
  });
  window.parent.postMessage({ type: 'yachiyo-ui-ready' }, '*');
})();
</script></body></html>`
  return { html, csp }
}

export function installGenerativeUiProtocol(): void {
  protocol.handle(GENERATIVE_UI_SCHEME, (request) => {
    if (!isGenerativeUiShellUrl(request.url)) return new Response('Not found', { status: 404 })
    const { html, csp } = buildGenerativeUiShell()
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })
}

/** Block shell-origin navigation before Electron's normal external-link handler can see it. */
export function installGenerativeUiNavigationGuard(contents: WebContents): void {
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    if (
      isGenerativeUiFrame(details.frame) ||
      isGenerativeUiFrame(details.initiator) ||
      (details.url.startsWith(`${GENERATIVE_UI_SCHEME}:`) && !isGenerativeUiShellUrl(details.url))
    ) {
      details.preventDefault()
    }
  })
}

const guardedSessions = new WeakSet<Electron.Session>()

/** Defense in depth against other privileged schemes (notably yachiyo-asset's bypassCSP). */
export function installGenerativeUiResourceGuard(contents: WebContents): void {
  const session = contents.session
  if (guardedSessions.has(session)) return
  guardedSessions.add(session)
  session.webRequest.onBeforeRequest(
    {
      urls: [
        'http://*/*',
        'https://*/*',
        'file://*/*',
        'ws://*/*',
        'wss://*/*',
        'yachiyo-asset://*/*',
        'yachiyo-ui://*/*'
      ]
    },
    (details, callback) => {
      callback({ cancel: isGenerativeUiFrame(details.frame) })
    }
  )
}
