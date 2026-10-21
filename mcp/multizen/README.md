# multizen-mcp

Stdio MCP server that lets DSH drive [MultiZen](https://multizen.app) fingerprint-browser
profiles. It fronts MultiZen's built-in HTTP MCP endpoint (`http://127.0.0.1:7777/mcp`) and adds
the pieces DSH needs to be actually useful with a browser.

```
DSH  ──stdio JSON-RPC──▶  server.mjs  ──HTTP Bearer──▶  MultiZen :7777  ──CDP/eval──▶  CloakBrowser profile
```

## Why a front-end and not a direct connection

MultiZen already speaks MCP over HTTP, so DSH can point at it directly. Four things make that
miserable in practice — all verified against MultiZen 0.2.0-pre on Windows:

| Problem | What happens on a direct connection | What this server does |
|---|---|---|
| `screenshot` payload | Returns a **text** block whose content is `{"pngBase64":"…"}` — ~69 000 characters of noise in the transcript, and DSH never renders an image. | Parses the JSON and returns a real `{type:"image", mimeType:"image/png"}` block. This alone is why the server exists. |
| Element targeting | Only CSS selectors. The model has to guess selectors from an accessibility dump. | `click_text` / `find_text` locate elements by **visible text**, return the measured selector and rect. |
| Interaction coverage | `click`, `type`, `extract`, `navigate`. No hover, no keys, no scroll, no `<select>`. | Adds `hover`, `press_key`, `scroll`, `select_option`, `fill`. |
| `type` / `click` reliability | Both return `{"ok":true}` and do **nothing** on CloakBrowser profiles (see below). | `fill` and `click_text` go through the DOM instead. |

### The CloakBrowser caveat that shapes everything

CloakBrowser is an anti-detect Chromium build. On it, **DevTools `Input` events are swallowed**:

- `Input.dispatchMouseEvent` (`mousePressed`/`mouseReleased`) returns `{}` with no error and the
  page never sees a click. No `onclick`, no form submit, no navigation.
- `Input.dispatchKeyEvent` likewise does nothing.
- `Input.dispatchMouseEvent` **`mouseMoved` does work** — it drives the compositor, so CSS
  `:hover` reacts to it even though the page gets no click.

Measured directly (`test/diag.mjs`):

```
elementFromPoint(60.19, 97.875)  -> BUTTON#btn        # coordinates are correct
MultiZen click('#btn')           -> {"ok":true}       # #out stayed "idle"
MultiZen type('#q','abc123')     -> {"ok":true}       # #q.value stayed ""
raw CDP mousePressed/Released    -> {} twice          # #out stayed "idle"
document.getElementById('btn').click()  -> #out = "clicked-once"   # works
```

So the defaults are DOM-based:

- `click_text` → synthetic `pointerdown`/`mousedown`/`pointerup`/`mouseup` + native `el.click()`
  (which is what actually runs handlers and default actions). `native:true` opts back into CDP
  input for engines that honour it.
- `press_key` → `KeyboardEvent` + explicit caret insertion. A synthetic `keydown` does **not**
  run default actions, so `Enter` inside a form calls `form.requestSubmit()` explicitly and the
  result reports `submitted:true`.
- `fill` → native value setter, then `input` + `change` (keeps React/Vue state in sync).
- `hover` → CDP `mouseMoved` (for CSS `:hover`) **plus** DOM `mouseover`/`mouseenter` (for JS).

## Requirements

- MultiZen desktop app running, with **Settings → MCP server** enabled (port 7777).
- Node.js 18+ (the launcher path in the DSH config points at `C:\Program Files\nodejs\node.exe`).
- At least one profile (create one in the MultiZen UI first).

The bearer token is read from `%APPDATA%\MultiZen\mcp-token`, so nothing is hard-coded. Override
with `MZ_TOKEN` / `MZ_BASE` if needed.

## DSH configuration

Registered in `C:\Users\lt\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- id: mcp-multizen
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: multizen
    transport: stdio
    command: "C:/Program Files/nodejs/node.exe"
    args:
      - "C:/Users/lt/Documents/deepseek-harness/default-workspace/multizen-mcp/server.mjs"
    toolCallTimeoutMs: 180000
    failOnStartupError: true
```

Restart DSH after changing that file. Changes to `server.mjs` only need a restart of the MCP
client (or the whole app), not a config edit.

## Tools (30)

**Proxied from MultiZen (22):** `list_profiles`, `create_profile`, `update_profile`,
`delete_profile`, `list_fingerprint_options`, `launch_profile`, `close_profile`, `navigate`,
`click`, `type`, `extract`, `evaluate_js`, `wait_for_selector`, `wait_for_navigation`,
`wait_for_load`, `list_tabs`, `new_tab`, `activate_tab`, `close_tab`, `get_cookies`,
`set_cookies`, `screenshot` *(rewritten to return an image block)*.

**Added here (8):**

| Tool | Purpose |
|---|---|
| `click_text` | Click by visible text; auto-scrolls, reports the measured selector |
| `find_text` | List text matches with tag/selector/size/clickable, without clicking |
| `get_text` | Read a selector's text or an attribute, or the whole page (url/title/text) |
| `fill` | Replace an input/textarea/contenteditable value reliably |
| `press_key` | Send Enter/Tab/Escape/arrows/PageDown or one character; Enter submits forms |
| `scroll` | Scroll the window or a specific element, reports before/after |
| `select_option` | Pick a `<select>` option by value or label |
| `hover` | Trigger CSS `:hover` and JS hover handlers |

## Typical session

```
list_profiles                        -> pick a profile id
launch_profile {profile_id}          -> opens a visible window (idempotent, required first)
navigate {profile_id, url}
screenshot {profile_id}              -> image block
get_text {profile_id}                -> url/title/text, or a selector's text
find_text {profile_id, text:"Sign in"} -> candidates with selectors
click_text {profile_id, text:"Sign in"}
fill {profile_id, selector:"#email", value:"…"}
press_key {profile_id, key:"Enter"}
close_profile {profile_id}
```

## Known limits

- **No headless.** MultiZen always opens a visible desktop window.
- **CAPTCHA / 2FA** are for the human to solve; these tools do not and should not bypass them.
- `el.click()` sets `isTrusted:false`. Sites that specifically reject untrusted events will need
  `click_text {native:true}` — which, on CloakBrowser, mostly will not work either.
- **`screenshot` stalls on some real-world sites.** It returns in ~1s on trivial pages
  (`example.com` → 51 KB PNG) but hangs past 180 s on `wikipedia.org` and `news.ycombinator.com`,
  while `navigate` / `evaluate_js` / `get_text` on those same pages stay fast. MultiZen's own
  screenshot path appears to wait for a page condition that busy sites never satisfy. Workaround:
  read with `get_text` and only reach for `screenshot` when you need the pixels, on pages you
  know are quiet.
- One profile at a time is fine; parallel use of the same profile will interleave.
- **`tools/mz.mjs` `--save` note.** MultiZen ships screenshots as `{"pngBase64":"…"}` inside a
  **text** block, not an `image` block. A naive `console.log` of that block dumps ~69 k characters
  of base64 into the transcript. `mz.mjs` now decodes any >2000-char text block that parses as JSON
  with `pngBase64`/`base64`/`image`/`data` straight to a file.

## Tests

```powershell
cd multizen-mcp
node test\serve.mjs                      # serves the fixture on :8848 (keep running)
node test\verify-tools.mjs               # 11 assertions against a real profile
node test\diag.mjs                       # reproduces the CDP-input findings above
```

`verify-tools.mjs` exits 0 only when all 11 pass. It writes `test/verify-shot.png`.

## Files

| Path | Role |
|---|---|
| `server.mjs` | The whole server: MultiZen client, 8 extra tools, stdio JSON-RPC |
| `tools/mz.mjs` | CLI to poke MultiZen directly — `node mz.mjs tools`, `node mz.mjs call list_profiles '{}'` |
| `tools/asar2.js` | Reads Electron `app.asar` (chromium Pickle header) — `list` / `grep` / `dump` |
| `test/serve.mjs` | Fixture page server on :8848 |
| `test/verify-tools.mjs` | End-to-end assertions |
| `test/diag.mjs` | Input-swallowing diagnosis |
