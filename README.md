# dsh-tool-computer

**Computer use for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)**, on two
fronts:

- **`browser`** — drives Chrome or Edge over the DevTools Protocol. **Zero
  dependencies.** The fast, deterministic path for anything that happens in a web
  page.
- **`computer`** — drives the Windows desktop: screenshots that actually reach the
  model, mouse, keyboard, scroll and window control. For everything outside the
  browser.

Built to solve one concrete problem: let an agent *look* and *act*, with the image
genuinely arriving at the model, and without paying a visual inference for every
click.

> Status: works and is tested against real Chrome and a real desktop. Windows only.
> See [SECURITY.md](SECURITY.md) before you install it — this gives an agent control
> of your machine.

## Why two paths

The classic *pixel-to-action* loop is expensive: capture the whole screen, send the
image to the model, have it guess coordinates, move the mouse, wait, repeat. That is
seconds per step, and every click is approximate.

When the task lives in a browser you do not have to guess anything: the page already
says which elements it has, what they are called and where they are. Measured on a
real machine, same browser:

| Operation | `browser` (CDP) | Pixel loop |
| --- | --- | --- |
| Read the whole page | **28 ms** | 0.5–1 s + visual inference |
| Click an element | **139 ms** | 2–6 s (coordinate guessing) |
| Read an exact value | **9 ms** | visual inference |
| Type into a field | **152 ms** | 2–6 s |
| Screenshot the tab | **165 ms** | 0.5–1 s |
| Navigate | 2.9–3.3 s | 2.9–3.3 s (that is the network) |

It is not only speed: a click by reference **cannot** miss by a pixel, or break on a
different screen resolution, or land on a cookie banner that appeared meanwhile.

## Install

Requirements: Windows, Node 22+ (for the built-in `WebSocket`), and DeepSeek
Harness with a profile.

1. Copy the `computer/` folder into your DSH profile:

   ```sh
   cp -r computer "$DSH_HOME/profiles/<profile>/plugins/computer"
   ```

2. Add the plugin row to the profile patch
   (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: tool-computer
         name: ./plugins/computer/index.js
         config:
           maxWidth: 1600
           maxHeight: 1000
   ```

   `name` is relative to the profile folder, because the loader's `baseUrl` points
   there. From a `--patch` layer elsewhere, use a `file:///...` URL instead.

3. Restart DSH: the plugin tree is composed at startup.

There is nothing to install: a DSH profile's `node_modules` is empty, so the plugin
imports nothing from `@deepseek-ai/*`. It implements by hand the
`Config['~standard'].validate` that Cordis consumes, and registers its tools with
plain objects.

## If it breaks, fix it without the agent

This section exists because of a real outage, and because of an uncomfortable
property of this whole category of tool: **when a plugin breaks the session, the
agent cannot repair it.** Tool schemas are sent with every request, so an invalid
one fails *every* turn — including the turn that would run the fix. The agent is
not a recovery path. You are.

So the plugin ships a check that does not depend on the plugin working, and a
recovery procedure short enough to do from a text editor.

### Check it by hand, any time

```sh
node "$DSH_HOME/profiles/<profile>/plugins/computer/lib/health-check.js"
```

It exits `0` and prints `health check passed` when the plugin is safe to load. It
exits `1` and lists exactly what is wrong when it is not — and tells you how to
disable it. It builds the tool schemas and inspects them the way a strict provider
validator would: every array needs an object `items` with a type, `required` must
be an array of names, no union types, every object needs `additionalProperties`.
It needs no network, writes nothing, and starts nothing.

### Disable it, which always works

In `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, find the `tool-computer` row
and set `disabled: true`:

```yaml
- insert:
    - id: tool-computer
      name: ./plugins/computer/index.js
      disabled: true          # <- this line
      config:
        maxWidth: 1600
```

Then restart DSH.

Two things to watch, both learned the hard way:

- **Indentation matters.** `name`, `disabled` and `config` must be indented under
  `- id:`, aligned with each other. If they are not, the patch is malformed and the
  plugin keeps loading — a hand-edit that "did not work" is usually this.
- **A local plugin has no version to roll back to.** It is a file: every restart
  loads whatever is on disk right now. There is no previously-working build to
  return to, which is why `disabled: true` is the recovery lever rather than a
  downgrade.

### Why the schemas are the fragile part

The provider validates the whole tool list before running anything, so one bad
node rejects all of it. And DSH validates the value a tool *returns* against
`output.schema` — never the parameters it declares — so a malformed parameter
schema produces no local error at all. It surfaces as
`Invalid schema for function 'x': ...`, on every turn.

Two scripts exist for that reason and are meant to be run before shipping any
change to a tool:

```sh
node scripts/schema-guard.mjs          # asserts the published schema shape
node scripts/inspect-wire-schema.mjs   # prints exactly what goes on the wire
```

## Configuration

Every option is optional.

```yaml
config:
  maxWidth: 1600                 # screenshot width cap (px)
  maxHeight: 1000                # screenshot height cap (px)
  timeoutMs: 30000               # per-call budget
  captureAfterActions: false     # attach a fresh screenshot after click/type/key
  persistentShell: true          # keep one warm PowerShell per session (see below)
  requireApprovalFor: []         # actions that must ask the user first
  browserMode: null              # pin a browser mode, or leave null to ask per task
  browserProfileDir: null        # Chrome user-data dir for the "real profile" mode
```

## Tool `browser` — 9 actions

| Action | What it does |
| --- | --- |
| `snapshot` | Reads the page: interactive elements indexed (`e1`, `e2`...) with their label, state and focus, plus the visible text |
| `click` | Clicks an element by `ref` from the snapshot, or by CSS selector |
| `type` | Types into a field, optionally clearing it first and pressing Enter |
| `press` | Presses a key, with modifiers |
| `navigate` | Goes to a URL and returns the snapshot |
| `evaluate` | Runs JavaScript and returns the result: for exact data |
| `screenshot` | Captures the tab as an image, when the visual matters |
| `wait` | Waits for a text or a selector to appear |
| `tabs` | Lists open tabs |

The flow is: `snapshot` -> read the references -> `click`/`type` with that `ref` ->
new `snapshot`. The model never invents a selector or a coordinate.

### The three browser modes, chosen per task

The browser does not connect one single way, because the compartment changes with
what you are doing. **The agent does not guess which mode to use**: a call that does
not declare one fails, and asks the model to ask you.

| Mode | What it does | When |
| --- | --- | --- |
| `perfil-propio` | Chrome with a fresh, isolated profile; touches none of your tabs or sessions | Day-to-day work. Log into the site once |
| `perfil-real` | Your everyday Chrome, with your sessions already open | When you are already logged in. Requires closing Chrome first |
| `sin-navegador` | Does not touch the browser at all | Banking, personal paperwork, anything you do not want exposed |

The choice **is not inherited** between tasks: every call carries its own `mode`, and
the plugin closes the previous connection when the mode changes, so it cannot reuse a
browser opened with a different profile. To stop being asked, pin one:

```yaml
config:
  browserMode: perfil-propio
```

If the real profile is in use, the plugin says so immediately (and what to do) with
an instant lock-file check, instead of waiting 45 seconds for a port that will never
answer.

## Tool `computer` — 16 actions

| Action | What it does |
| --- | --- |
| `screenshot` | Captures the screen and returns **the image to the model** |
| `click`, `double_click`, `right_click` | Clicks at x,y |
| `move`, `drag` | Moves the cursor, drags |
| `scroll` | Mouse wheel |
| `type` | Types into the focused window |
| `key`, `keys` | One key, or a combination (`["ctrl","shift","s"]`) |
| `cursor` | Where the cursor is and what has focus |
| `windows` | Lists windows: title, process, PID, rect, focus |
| `focus_window`, `close_window` | Bring to front, ask to close |
| `start_app` | Opens an app from a closed list |
| `wait` | Waits for the UI to settle |

Coordinates can be absolute screen pixels (`space: "screen"`) or **measured on the
screenshot the model just looked at** (`space: "image"`, the default): the plugin
stores the image-to-screen mapping and translates.

## How the image reaches the model

This is the part that is easy to get wrong. The DSH tool registry validates the value
returned by `execute` against `output.schema`, and it means it: with
`additionalProperties: false`, putting the content inside the value invalidates the
whole result (`INVALID_TOOL_OUTPUT`) and the model receives nothing — neither text nor
image.

The correct path is `finalizeContent`: the value stays clean (`{ action, result }`),
gets validated, and the content — text and image blocks — is attached afterwards:

```js
const pendingContent = new WeakMap()

// in execute(): publish the capture and record its blocks
const reference = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name })
pendingContent.set(exec, [
  { type: 'text', text: 'screenshot frame 7: 1600x664 px ...' },
  { type: 'image', attachment: reference },
])
return { action, result }

// in the tool definition
finalizeContent(exec) {
  const content = pendingContent.get(exec)
  pendingContent.delete(exec)
  return content
}
```

The runtime attaches that image to the model's context in the same turn, so it sees it
on the next step. Verified end to end: a unique token typed on screen was read back
from the screenshot alone — see [docs/vision-proof.png](docs/vision-proof.png).

## Desktop performance

Each `computer` action costs what starting PowerShell costs... unless you stop
starting one per action. Measured with two monitors at 5206x2160:

| | Per action |
| --- | --- |
| New process per action | 8.6 – 10.4 s |
| **Persistent server** (default) | **12 ms** after warm-up |

The runner has two modes sharing one code path (`Invoke-Request`):

- **Server** (`-Server`): one live PowerShell per session, one JSON request per line,
  one JSON response per line.
- **Single process**: the fallback, and the convenient mode for testing by hand.

The plugin starts the server in the background when it mounts, closes it after 10
minutes idle, closes it with the DSH process, and **falls back to single-process mode
if the server fails, dies or stops answering** instead of breaking the action.

## Requirements and limits

- **Windows.** Uses GDI to capture and `SendInput`/`SetCursorPos` for input.
- **Node 22 or newer**, for the built-in `WebSocket` the browser tool speaks CDP
  over. No package is installed at any point.
- **The process hosting the plugin must be able to touch the desktop.** In DSH, shell
  calls are confined with a low-integrity restricted token, and that token **cannot**
  move the cursor or inject input (verified: inside the sandbox `SetCursorPos` returns
  `False`). The plugin runs its runner from the host process, not through the confined
  shell. This is a deliberate decision, explained in [SECURITY.md](SECURITY.md).
- **The active model must accept images**, or `screenshot` is refused with a clear
  message. Same requirement as DSH's own `read_image` tool.
- **Multi-monitor**: `screenshot` captures the whole virtual desktop. The capture is
  normalized to a pixel budget, and the coordinate mapping adapts.
- **Capturing the screen captures everything on it.** If what you want to supervise
  lives in one window, capture that window rather than the whole desktop.

## Contributing

Bug reports and improvements are welcome, especially from setups other than the one
this was built on — it talks to GDI, `SendInput`, Chrome's DevTools Protocol and a DSH
profile, and failures tend to be specific to one of those.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it lists the two checks to run before
  a pull request, the house style, and the two constraints worth knowing before you
  design anything.
- [Open an issue](https://github.com/lavg43-oss/dsh-tool-computer/issues/new/choose) —
  there are forms for bugs and for ideas, and the bug form asks for the environment
  details that actually matter.
- If you are changing behaviour, please add or adjust a check in `scripts/`. The
  repository's habit is that a claim about cleanup or correctness is asserted by a
  script, not by a comment.

## Development

```sh
node scripts/audit-repo.mjs .          # no machine paths, no secrets, no non-Node imports
node scripts/browser-integration.mjs   # real Chrome, 9 browser actions, cleans up after itself
```

`audit-repo.mjs` is the check that keeps this repository safe to publish: it fails if a
path from the author's machine, a credential, or an import outside Node slips in.
`browser-integration.mjs` launches a throwaway browser and asserts it leaves **zero**
processes behind — a bug this project shipped once and fixed with a process-tree kill.

## Credits and prior art

If you are new to computer use, read Anthropic's
[computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
first: it is the behavioural reference, and its action-dispatcher design (`action` plus
parameters) is the one this project follows. There is no code of theirs here — they do
not publish an implementation — and none of their documentation is reproduced; see
[NOTICE.md](NOTICE.md).

The CDP approach follows the same reasoning as browser automation projects such as the
accessibility-tree readers: read the structure, not the pixels.

## License

MIT. See [LICENSE](LICENSE).
