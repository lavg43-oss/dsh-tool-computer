# Contributing

Thanks for looking. This is a small, focused tool: it gives a DeepSeek Harness
agent two ways to act — through a real browser's structure, and through the
Windows desktop with vision. Improvements are welcome, and so are bug reports
from setups other than the one it was built on.

## Ways to help

- **Report a bug.** Use the [issue form](https://github.com/lavg43-oss/dsh-tool-computer/issues/new/choose).
  The environment questions matter more than they look: this tool talks to GDI,
  `SendInput`, Chrome's DevTools Protocol and a DSH profile, and a failure is
  usually specific to one of those.
- **Improve a description.** The tool descriptions are the model's instructions.
  If an action confused an agent, that is a real bug and often a one-paragraph fix.
- **Add an action.** Both dispatchers are tables: an entry in `ACTION_SPECS` (or
  `BROWSER_ACTIONS`) plus the implementation.
- **Port it.** The desktop half is Windows-only by construction, but the browser
  half is not: it only needs Node 22+ and any Chromium with remote debugging.

## Before you open a pull request

Run these two. The first is the check that keeps the repository publishable; the
second exercises the browser tool against a real Chrome and cleans up after
itself.

```sh
node scripts/audit-repo.mjs .
node scripts/browser-integration.mjs
```

`audit-repo.mjs` fails if a path from your machine, a credential, or an import
outside Node slips in. `browser-integration.mjs` exits non-zero if it leaves a
browser process or a temporary profile behind — that bug shipped once, so it is
now asserted.

Also confirm the syntax of anything you touched:

```sh
node --check computer/index.js
powershell -NoProfile -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('computer/lib/computer.ps1',[ref]$null,[ref]$e); $e.Count"
```

## Two ways to break every turn, not just one action

Both of these have happened in this project, so they are worth more than a glance.

**1. An invalid tool schema.** The provider validates the whole tool list before
running anything, so one malformed node rejects all of it and every turn fails
with a message like `Invalid schema for function 'browser': true is not of type
"array"`. The subtle part: DSH validates the value a tool *returns* against
`output.schema`, so a bad `parameters` schema is never caught locally. The mistake
that caused it here was sending parameters in DSH's **author form**
(`required: true` per property, the shape `defineTool` compiles) while registering
the tool directly, so a boolean reached a place that wanted an array of names.
`scripts/schema-guard.mjs` now asserts the published shape; run it before and
after touching any parameter.

**2. Deleting `"type": "module"` from `computer/package.json`.** Running
`npm install <anything>` inside `computer/` rewrites that file and drops the line.
Node then reads `index.js` as CommonJS and the plugin refuses to load with
`Unexpected token 'export'`. The plugin has no dependencies and must stay that
way: never run a package manager inside that folder.

## House style

- **No dependencies.** The plugin imports nothing outside Node builtins and its
  own files. That is a feature: a DSH profile has an empty `node_modules`, and
  the whole point is that this installs by copying a folder.
- **Comments explain why, not what.** The interesting parts of this code are the
  decisions: why the content cannot live inside the value a tool returns, why the
  runner is launched from the host process, why a process tree needs
  `taskkill /T`, why a mode is never inherited. Those deserve a sentence.
- **Errors are for the model.** When a tool fails, the message is read by an
  agent that must recover. Say what failed, what to do next, and never leave it
  guessing. Messages and code comments are in English; user-facing strings the
  model reads are in English too.
- **Parameter descriptions say when to use the parameter**, not only what it is.

## Two constraints worth knowing before you design something

1. **A tool's returned value is validated against its `output.schema` with
   `additionalProperties: false`.** Put the content (text, images) *inside* that
   value and the whole result is rejected with `INVALID_TOOL_OUTPUT` and the model
   receives nothing. Content travels through `finalizeContent` instead.
2. **DSH confines shell calls with a low-integrity restricted token that cannot
   inject desktop input.** A tool that needs to move the cursor must run its
   runner from the host process. This is explained in [SECURITY.md](SECURITY.md);
   if you change it, say why in the pull request.

## Scope

Useful and in scope: new actions, better snapshots, more reliable cleanup, Linux
and macOS support for the browser half, documentation fixes, and bug reports with
a reproduction.

Out of scope: anything that phones home, anything that adds a runtime
dependency, and anything that makes the tool act without the user being able to
see what it is doing. This tool watches a screen that has private things on it;
that constraint is not negotiable.

## License

By contributing you agree that your contribution is licensed under the MIT
License, as in [LICENSE](LICENSE).
