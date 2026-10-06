/**
 * dsh-tool-computer - computer use for DSH on Windows.
 *
 * It registers two tools:
 *
 * - `computer`: controls the Windows desktop with real vision (an `image` block
 *   over `ctx.attachments`), plus clicking, typing, scrolling and windows. The
 *   native work is done by `lib/computer.ps1`, which reads one JSON request from
 *   stdin and writes one JSON response to stdout, either as a persistent server
 *   or as a single process.
 * - `browser`: drives Chrome or Edge over the DevTools Protocol, with no
 *   dependencies. It reads the page structure and acts by reference instead of
 *   estimating coordinates: the fast, deterministic path for web work.
 *
 * @module dsh-tool-computer
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_ACTIONS, browserDescription, createBrowserService } from './lib/browser-tool.js'

/** Stable loader row identity. */
export const name = 'tool-computer'

/**
 * Configuration schema in the shape Cordis consumes: an object with
 * `~standard.validate`. Written by hand so the plugin imports nothing from
 * `@deepseek-ai/*` (a profile has none of those packages in its node_modules).
 */
function integerField(fallback, min, max) {
  return {
    coerce: (value) => {
      if (!Number.isSafeInteger(value)) return fallback
      if (value < min) return min
      if (value > max) return max
      return value
    },
    check: (value) => Number.isSafeInteger(value) && value >= min && value <= max,
    describe: `an integer between ${min} and ${max}`,
  }
}

const CONFIG_FIELDS = {
  maxWidth: integerField(1600, 320, 4096),
  maxHeight: integerField(1000, 240, 4096),
  typeDelayMs: integerField(8, 0, 500),
  timeoutMs: integerField(30000, 1000, 600000),
  // How much page a snapshot returns. The `browser` tool documents these as
  // coming from "the plugin configuration", which was not true while they were
  // missing from the resolved config: the service always used its own defaults.
  maxElements: integerField(60, 1, 500),
  maxTextChars: integerField(2500, 200, 20000),
}

/** Valid actions, duplicated here so the configuration schema knows them without depending on ACTION_SPECS. */
const CONFIG_ACTIONS = [
  'screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll',
  'type', 'key', 'keys', 'cursor', 'windows', 'focus_window', 'close_window', 'start_app', 'wait',
]

/** Validated plugin configuration, plus the fields that need no range. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-tool-computer',
    validate(input) {
      const source = input === null || typeof input !== 'object' ? {} : input
      const issues = []
      for (const key of Object.keys(source)) {
        const known = key === 'captureAfterActions'
          || key === 'requireApprovalFor'
          || key === 'persistentShell'
          || key === 'browserMode'
          || key === 'browserProfileDir'
          || key === 'ownProfileDir'
          || key === 'browserPorts'
          || key === 'browserExecutable'
          || Object.hasOwn(CONFIG_FIELDS, key)
        if (!known) issues.push({ message: `unknown configuration property: ${key}`, path: [key] })
      }
      if (Object.hasOwn(source, 'persistentShell') && typeof source.persistentShell !== 'boolean') {
        issues.push({ message: 'persistentShell must be a boolean', path: ['persistentShell'] })
      }
      if (Object.hasOwn(source, 'browserMode') && !['perfil-propio', 'perfil-real', 'sin-navegador'].includes(source.browserMode)) {
        issues.push({ message: 'browserMode must be "own-profile", "real-profile" or "no-browser" (Spanish aliases perfil-propio, perfil-real, sin-navegador also accepted)', path: ['browserMode'] })
      }
      if (Object.hasOwn(source, 'browserProfileDir') && source.browserProfileDir !== null && typeof source.browserProfileDir !== 'string') {
        issues.push({ message: 'browserProfileDir must be a path or null', path: ['browserProfileDir'] })
      }
      if (Object.hasOwn(source, 'ownProfileDir') && source.ownProfileDir !== null && typeof source.ownProfileDir !== 'string') {
        issues.push({ message: 'ownProfileDir must be a path or null', path: ['ownProfileDir'] })
      }
      if (Object.hasOwn(source, 'browserPorts') && source.browserPorts !== null) {
        if (!Array.isArray(source.browserPorts) || source.browserPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535)) {
          issues.push({ message: 'browserPorts must be a list of TCP ports', path: ['browserPorts'] })
        }
      }
      if (Object.hasOwn(source, 'browserExecutable') && source.browserExecutable !== null && typeof source.browserExecutable !== 'string') {
        issues.push({ message: 'browserExecutable must be a path or null', path: ['browserExecutable'] })
      }
      if (Object.hasOwn(source, 'captureAfterActions') && typeof source.captureAfterActions !== 'boolean') {
        issues.push({ message: 'captureAfterActions must be a boolean', path: ['captureAfterActions'] })
      }
      if (Object.hasOwn(source, 'requireApprovalFor') && source.requireApprovalFor !== undefined && source.requireApprovalFor !== null) {
        if (!Array.isArray(source.requireApprovalFor)) {
          issues.push({ message: 'requireApprovalFor must be a list of actions', path: ['requireApprovalFor'] })
        } else {
          for (const [index, entry] of source.requireApprovalFor.entries()) {
            if (typeof entry !== 'string' || !CONFIG_ACTIONS.includes(entry)) {
              issues.push({ message: `requireApprovalFor[${index}] is not a valid action: ${JSON.stringify(entry)}`, path: ['requireApprovalFor', index] })
            }
          }
        }
      }
      for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
        if (!Object.hasOwn(source, key) || source[key] === undefined || source[key] === null) continue
        if (!field.check(source[key])) issues.push({ message: `${key} must be ${field.describe}`, path: [key] })
      }
      if (issues.length > 0) return { issues }
      const value = {
        captureAfterActions: source.captureAfterActions === true,
        persistentShell: source.persistentShell !== false,
        requireApprovalFor: Array.isArray(source.requireApprovalFor) ? [...source.requireApprovalFor] : [],
        // With no value, the choice is asked of the user on every task.
        browserMode: ['perfil-propio', 'perfil-real', 'sin-navegador'].includes(source.browserMode) ? source.browserMode : null,
        browserProfileDir: typeof source.browserProfileDir === 'string' && source.browserProfileDir !== '' ? source.browserProfileDir : null,
        // A stable directory for `own-profile`: set it and the isolated browser
        // keeps its logins between tasks instead of starting from nothing.
        ownProfileDir: typeof source.ownProfileDir === 'string' && source.ownProfileDir !== '' ? source.ownProfileDir : null,
        browserPorts: Array.isArray(source.browserPorts) ? [...source.browserPorts] : null,
        browserExecutable: typeof source.browserExecutable === 'string' && source.browserExecutable !== '' ? source.browserExecutable : null,
      }
      for (const [key, field] of Object.entries(CONFIG_FIELDS)) value[key] = field.coerce(source[key])
      return { value }
    },
  },
}

/** Required services: the tool registry, the attachment store and model routes. */
export const inject = ['tools', 'attachments', 'llm']

/**
 * Asks the user to authorise an action, when the deployment requires it.
 *
 * Consumed opportunistically, the way the rest of the harness does: a deployment
 * with no approval service grants nothing, and the failure is closed.
 *
 * @param ctx - plugin context.
 * @param exec - execution context.
 * @param action - action that needs permission.
 */
async function assertApproved(ctx, exec, action) {
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(`computer(${action}): this action requires authorisation (requireApprovalFor config) and this deployment has no approval service; remove "${action}" from requireApprovalFor or mount the service`)
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'computer',
    callId: exec.callId,
    reason: `computer use: ${action}`,
    displayReason: `Computer use wants to run "${action}" on the desktop`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`computer(${action}): the action was not authorised (${outcome}); nothing ran`)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'lib', 'computer.ps1')

/** Accepted key names, so the model does not have to guess. */
const KEY_NAMES = [
  'enter', 'return', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete', 'del', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'left', 'right', 'up', 'down', 'ctrl', 'control', 'shift',
  'alt', 'win', 'windows', 'apps', 'capslock', 'numlock', 'printscreen', 'pause',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'a-z', '0-9', 'numpad0-numpad9', 'plus', 'minus', 'comma', 'period', 'slash', 'backslash',
  'semicolon', 'quote', 'lshift', 'rshift', 'lctrl', 'rctrl', 'lalt', 'ralt',
].join(', ')

/** Fields shared by the actions that target a pixel. */
const POINT_FIELDS = {
  x: {
    type: 'integer',
    required: true,
    description: 'X coordinate, rounded to an integer.',
  },
  y: {
    type: 'integer',
    required: true,
    description: 'Y coordinate, rounded to an integer.',
  },
  space: {
    type: 'string',
    enum: ['screen', 'image'],
    description: "Reference frame for x/y. 'screen' = absolute virtual-desktop pixels. 'image' = pixels of the capture you just looked at; this is the default, because that is where you measured.",
  },
  frame: {
    type: 'integer',
    description: 'Frame number returned by the capture, when the action uses image coordinates. Defaults to the most recent capture.',
  },
}

const ACTION_SPECS = {
  screenshot: {
    summary: 'Captures the screen and returns the image so you can see it.',
    parameters: {
      maxWidth: { type: 'integer', description: 'Maximum width of the captured PNG. Defaults to the plugin configuration.' },
      maxHeight: { type: 'integer', description: 'Maximum height of the captured PNG. Defaults to the plugin configuration.' },
    },
    required: [],
  },
  click: { summary: 'Moves the cursor to x,y and left-clicks.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  double_click: { summary: 'Double left-click at x,y. Use it to open icons or files.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  right_click: { summary: 'Right-click at x,y, for context menus.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  move: { summary: 'Only moves the cursor to x,y, without clicking. Useful to trigger hover.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  drag: {
    summary: 'Drags with the left button from x,y to x2,y2.',
    parameters: {
      ...POINT_FIELDS,
      x2: { type: 'integer', required: true, description: 'Destination X coordinate.' },
      y2: { type: 'integer', required: true, description: 'Destination Y coordinate.' },
    },
    required: ['x', 'y', 'x2', 'y2'],
  },
  scroll: {
    summary: 'Mouse wheel at the current cursor position.',
    parameters: {
      amount: { type: 'integer', description: 'Positive scrolls up/left, negative down/right. Defaults to 3.' },
      horizontal: { type: 'boolean', description: 'true for horizontal scrolling.' },
    },
    required: [],
  },
  type: {
    summary: 'Types text into the focused window, character by character. Does not press Enter.',
    parameters: {
      text: { type: 'string', required: true, description: 'Literal text to type.' },
      delayMs: { type: 'integer', description: 'Pause between characters, in milliseconds. Defaults to the plugin configuration.' },
    },
    required: ['text'],
  },
  key: {
    summary: 'Presses a single key.',
    parameters: {
      key: { type: 'string', required: true, description: `Key name, case-insensitive: ${KEY_NAMES}.` },
    },
    required: ['key'],
  },
  keys: {
    summary: 'Presses a combination, holding every key until the end. Use it for shortcuts.',
    parameters: {
      keys: {
        type: 'array',
        required: true,
        description: "Keys in order, for example ['ctrl','shift','s'] or ['alt','tab'].",
        items: { type: 'string' },
      },
    },
    required: ['keys'],
  },
  cursor: { summary: 'Where the cursor is now, and which window has focus.', parameters: {}, required: [] },
  windows: { summary: 'Lists windows with title, process, PID, rectangle and which one has focus.', parameters: {}, required: [] },
  focus_window: {
    summary: 'Brings a window to the front and gives it focus.',
    parameters: {
      title: { type: 'string', description: 'Title fragment, case-insensitive. Required when handle is not given.' },
      handle: { type: 'integer', description: 'Exact handle returned by windows. Takes precedence over title.' },
    },
    required: [],
  },
  wait: {
    summary: 'Waits for the interface to settle.',
    parameters: {
      ms: { type: 'integer', description: 'Milliseconds to wait, at most 30000. Defaults to 500.' },
    },
    required: [],
  },
  close_window: {
    summary: 'Asks a window to close (sends WM_CLOSE, like the close button). Use it to dismiss dialogs.',
    parameters: {
      title: { type: 'string', description: 'Title fragment. Required when handle is not given.' },
      handle: { type: 'integer', description: 'Exact handle returned by windows. Takes precedence over title.' },
    },
    required: [],
  },
  start_app: {
    summary: 'Opens an application from the allowed list and returns its window, handle and PID.',
    parameters: {
      app: {
        type: 'string',
        required: true,
        enum: ['notepad', 'calculator', 'paint', 'explorer', 'cmd', 'powershell'],
        description: 'Application to open. Closed list: it does not accept paths or arbitrary executables.',
      },
    },
    required: ['app'],
  },
}

const ACTIONS = Object.keys(ACTION_SPECS)

/** Whether the given keys form a combination rather than a single key. */
function isChord(keys) {
  return Array.isArray(keys) && keys.length > 1
}

/**
 * Builds the dispatcher description from the declared actions.
 * @returns descripcion orientada al modelo.
 */
function buildDescription() {
  const lines = Object.entries(ACTION_SPECS).map(([action, spec]) => `- ${action}: ${spec.summary}`)
  return [
    'Controls the Windows desktop: captures the screen, moves the mouse, clicks, types and presses keys.',
    'The `action` parameter picks the behaviour; the remaining parameters are that action\'s own.',
    'Normal flow: `screenshot` (you will see the image attached), measure on it and then `click` with space="image"; repeat after every step that changes the screen.',
    'Start with `windows` or `focus_window` when the target window does not have focus: typing and key presses always go to the focused window.',
    '`click`, `type` and `key` act on whatever is under the cursor or focused at that moment; do not guess coordinates without a recent capture.',
    'Acciones:',
    ...lines,
  ].join('\n')
}

/**
 * Resolves the PowerShell executable path.
 *
 * Tries candidates in order and keeps the first that exists, because the install
 * varies between machines: Windows PowerShell 5.1 lives in System32, and
 * PowerShell 7 may be in Program Files, in the Microsoft Store (WindowsApps) or
 * only on the PATH. `DSH_PWSH` overrides everything else.
 *
 * The order prefers Windows PowerShell 5.1 because, measured on a real machine, a
 * fresh process takes 4.5-6.6 s with it against 9.8-18 s with the Store `pwsh`.
 * To force another interpreter, set `DSH_PWSH`.
 *
 * @returns an absolute interpreter path, or a bare name for the system to resolve.
 */
function resolvePwsh() {
  if (process.env.DSH_PWSH !== undefined && process.env.DSH_PWSH.trim() !== '') return process.env.DSH_PWSH
  const candidates = [
    // Windows PowerShell 5.1: ships with Windows and is the fastest here.
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    // PowerShell 7+, instalacion clasica y de la Store.
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '6', 'pwsh.exe'),
  ]
  for (const candidate of candidates) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      /* siguiente candidato */
    }
  }
  return 'powershell.exe'
}

/**
 * Client for the persistent PowerShell server.
 *
 * Starting PowerShell and compiling the native surface costs 8 to 22 seconds; a
 * later action against an already-live process costs milliseconds. This client
 * keeps a single process in `-Server` mode, writes one JSON request per line and
 * resolves with the response line.
 *
 * It is failure-tolerant by design: if the server does not start, dies, or stops
 * answering in time, the call falls back to single-process mode instead of failing.
 */
class ComputerServer {
  /**
   * @param scriptPath - absolute path of the runner.
   * @param executable - PowerShell interpreter.
   * @param childTimeoutMs - per-request limit.
   */
  constructor(scriptPath, executable, childTimeoutMs) {
    this.scriptPath = scriptPath
    this.executable = executable
    this.childTimeoutMs = childTimeoutMs
    this.child = null
    this.generation = 0
    this.buffer = ''
    this.pending = null
    this.stderrTail = ''
    this.lastUsedAt = 0
    this.watchdog = null
  }

  /** Starts the server when none is alive. */
  ensureStarted() {
    if (this.child !== null && this.child.exitCode === null && !this.child.killed) return
    this.generation++
    this.buffer = ''
    this.pending = null
    this.stderrTail = ''
    const generation = this.generation
    const child = spawn(
      this.executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Server'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (generation !== this.generation) return
      this.buffer += chunk
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (line !== '') this.settle(generation, line)
        index = this.buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000)
    })
    const onGone = () => {
      if (generation !== this.generation) return
      const waiting = this.pending
      this.pending = null
      this.child = null
      if (waiting !== null) waiting.reject(new Error(`the computer use server exited (${waiting.note})`))
    }
    child.on('exit', onGone)
    child.on('error', onGone)
  }

  /**
   * Hands a response line to whoever is waiting.
   * @param generation - generation of the server that answered.
   * @param line - JSON line.
   */
  settle(generation, line) {
    if (generation !== this.generation) return
    const waiting = this.pending
    if (waiting === null) return
    this.pending = null
    clearTimeout(waiting.timer)
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      waiting.reject(new Error(`the server returned a line that is not JSON: ${line.slice(0, 300)}`))
      return
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.ok === false && typeof parsed.error === 'string') {
      waiting.reject(new Error(parsed.error))
      return
    }
    waiting.resolve(parsed)
  }

  /**
   * Sends a request and waits for its response.
   * @param request - request object.
   * @param note - label for error messages.
   * @returns the runner response.
   */
  request(request, note) {
    this.ensureStarted()
    const generation = this.generation
    const child = this.child
    if (child === null || child.stdin === null) throw new Error('the computer use server has no stdin')
    this.lastUsedAt = Date.now()
    this.armWatchdog()
    return new Promise((resolve, reject) => {
      if (this.pending !== null) {
        reject(new Error('the computer use server already has a request in flight'))
        return
      }
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`the server did not answer within ${this.childTimeoutMs} ms (${note})${this.stderrTail === '' ? '' : `; stderr: ${this.stderrTail.slice(-400)}`}`))
        this.stop()
      }, this.childTimeoutMs)
      this.pending = { resolve, reject, timer, note }
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error === null || error === undefined) return
        if (this.pending !== null) {
          clearTimeout(this.pending.timer)
          this.pending = null
        }
        reject(new Error(`could not write to the server: ${error.message}`))
      })
    })
  }

  /** Closes the server after a while idle, so no PowerShell is left running. */
  armWatchdog() {
    if (this.watchdog !== null) return
    this.watchdog = setInterval(() => {
      if (this.child === null) return
      if (Date.now() - this.lastUsedAt < IDLE_SHUTDOWN_MS) return
      this.stop()
    }, 60_000)
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref()
  }

  /** Stops the server and leaves the client ready to start another one. */
  stop() {
    const child = this.child
    this.child = null
    this.generation++
    if (this.pending !== null) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
    if (child === null) return
    try {
      child.stdin?.end()
    } catch {
      /* the stream was already closed */
    }
    try {
      child.kill()
    } catch {
      /* it was already dead */
    }
  }
}

/** After this long without use, the server closes itself. */
const IDLE_SHUTDOWN_MS = 10 * 60_000

/**
 * Runs the runner in a fresh process: the server's fallback path.
 *
 * Uses `spawnSync` on purpose: in this environment `execFile` with the same script
 * and the same input never settles its callback (the child exits, the pipe does
 * not), and the call hangs forever. `spawnSync` always returns, with its own hard
 * time limit.
 *
 * @param request - request object serialized to stdin.
 * @param timeoutMs - limit for the child process.
 * @param signal - call cancellation, checked before starting.
 * @returns the JSON object returned by the runner.
 */
function runNativeOneShot(request, timeoutMs, signal) {
  if (signal?.aborted === true) throw new Error('computer: the call was cancelled before starting the runner')
  const executable = resolvePwsh()
  // The runner reads its request from stdin to the end: give it one and close the
  // stream, or it waits forever.
  const outcome = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    },
  )

  const text = (outcome.stdout ?? '').trim()
  if (outcome.error !== undefined && outcome.error !== null && text === '') {
    if (outcome.error.code === 'ETIMEDOUT') {
      throw new Error(`computer: the runner did not answer within ${timeoutMs} ms (${executable}); the action had no effect`)
    }
    throw new Error(`computer: could not start the runner (${executable}): ${outcome.error.message}`)
  }

  let parsed
  if (text !== '') {
    try {
      parsed = JSON.parse(text.split(/\r?\n/u).filter((line) => line.trim() !== '').at(-1))
    } catch {
      parsed = undefined
    }
  }

  if (parsed !== undefined && parsed.ok === true) return parsed
  if (parsed !== undefined && typeof parsed.error === 'string') throw new Error(parsed.error)

  const detail = (outcome.stderr ?? '').trim() || text || `exited with status ${outcome.status ?? 'unknown'}`
  throw new Error(`computer: the runner did not return JSON: ${detail.slice(0, 2000)}`)
}

/**
 * Child-process limit, below the tool limit so a stuck runner gives up before the
 * call budget does.
 * @param toolTimeoutMs - configured tool limit.
 * @returns milliseconds for the child process.
 */
function childTimeout(toolTimeoutMs) {
  return Math.max(5000, Math.min(toolTimeoutMs - 2000, 300000))
}

/**
 * Checks that the active route declares image input, the same gate `read_image` uses.
 * @param ctx - plugin context.
 * @param exec - tool execution context.
 * @param action - requested action, for the error message.
 */
async function assertImageCapableRoute(ctx, exec, action) {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) throw new Error(`computer(${action}): could not resolve the active model route`)
  const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`computer(${action}) returns an image and the active model ("${model}") does not accept one as input; pick a model with vision to use computer use`)
  }
}

/**
 * Actions whose x,y may come from the capture's coordinate space.
 */
const POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'move', 'drag'])

/**
 * Image-to-screen mapping of recent captures.
 *
 * Lives at module level, not inside `apply`, because two different functions need
 * it: tool execution and the helper that publishes a capture. Keeping it here also
 * means the mapping survives as long as the plugin is mounted.
 */
const computerFrames = {
  byFrame: new Map(),
  last: 0,
  /**
   * Remembers the geometry of one capture.
   * @param frame - frame number returned by the runner.
   * @param location - desktop rectangle the frame covers.
   * @param reference - published attachment reference.
   */
  record(frame, location, reference) {
    this.byFrame.set(frame, { location, scale: location.width / reference.width, reference })
    this.last = frame
    for (const key of this.byFrame.keys()) {
      if (key <= frame - 5) this.byFrame.delete(key)
    }
  },
  /**
   * Returns the mapping for a frame, or the most recent one.
   * @param frame - requested frame number.
   * @returns the mapping, or undefined when there is none.
   */
  get(frame) {
    const wanted = Number.isInteger(frame) ? frame : this.last
    return this.byFrame.get(wanted)
  },
  /** Forgets every mapping. */
  clear() {
    this.byFrame.clear()
    this.last = 0
  },
}

/**
 * Validates an action coordinate.
 * @param value - value from the model.
 * @param label - coordinate name, for the error.
 * @returns the same value.
 */
function integerCoordinate(value, label) {
  if (!Number.isInteger(value)) throw new Error(`computer: ${label} must be an integer; received ${JSON.stringify(value)}`)
  return value
}

/**
 * Translates an action coordinate into absolute virtual-desktop pixels.
 *
 * The default space is the image, because that is where the model measured: it
 * looks at a capture and reports pixels on that capture, and this maps them back
 * onto the desktop through the frame's scale factor.
 *
 * @param args - call arguments.
 * @param record - frame mapping, when there is one.
 * @returns absolute coordinates.
 */
function toScreen(args, record) {
  const x = integerCoordinate(args.x, 'x')
  const y = integerCoordinate(args.y, 'y')
  const space = args.space ?? (record === undefined ? 'screen' : 'image')
  if (space === 'screen') return { x, y }
  if (record === undefined) {
    throw new Error('computer: there is no recorded capture to interpret image coordinates with; call screenshot first, or pass space="screen" with absolute pixels')
  }
  return {
    x: Math.round(record.location.left + x * record.scale),
    y: Math.round(record.location.top + y * record.scale),
  }
}

/**
 * Publishes a capture and builds the content blocks that carry it to the model.
 *
 * @param ctx - plugin context, for the attachment store.
 * @param result - runner outcome for a capture.
 * @param note - first line of text, saying what the capture is.
 * @returns content blocks: one text block and the image itself.
 */
async function captureContent(ctx, result, note) {
  const data = readFileSync(result.path)
  const reference = await ctx.attachments.saveImage({
    data,
    mediaType: 'image/png',
    name: `screen-${result.frame}.png`,
  })
  computerFrames.record(result.frame, result.screen, reference)
  const scale = (result.screen.width / reference.width).toFixed(4)
  const lines = [
    note,
    `capture frame ${result.frame}: ${reference.width}x${reference.height} px over a desktop of ${result.screen.width}x${result.screen.height} px at (${result.screen.left}, ${result.screen.top})`,
    `to touch something you can see in the image at (px, py), pass space="image" with x=px, y=py (frame ${result.frame}); the plugin applies the factor ${scale}`,
  ].filter((line) => typeof line === 'string' && line !== '')
  return [
    { type: 'text', text: lines.join('\n') },
    { type: 'image', attachment: reference },
  ]
}

/**
 * Content blocks waiting to be attached to a tool result.
 *
 * The registry validates the value a tool returns against `output.schema` with
 * `additionalProperties: false`, so a `content` inside that value invalidates the
 * whole result (`INVALID_TOOL_OUTPUT`) and the model receives nothing. Content
 * travels through `finalizeContent` instead, keyed by the execution.
 */
const browserContent = new WeakMap()

/**
 * Registers both tools on the agent: `browser` (CDP) and `computer` (desktop).
 * @param ctx - agent-scoped services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = {
    maxWidth: Number.isSafeInteger(config.maxWidth) && config.maxWidth > 0 ? config.maxWidth : 1600,
    maxHeight: Number.isSafeInteger(config.maxHeight) && config.maxHeight > 0 ? config.maxHeight : 1000,
    typeDelayMs: Number.isSafeInteger(config.typeDelayMs) && config.typeDelayMs >= 0 ? config.typeDelayMs : 8,
    captureAfterActions: config.captureAfterActions === true,
    persistentShell: config.persistentShell !== false,
    timeoutMs: Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 30000,
    requireApprovalFor: Array.isArray(config.requireApprovalFor) ? config.requireApprovalFor : [],
    // With no mode configured, the user is asked on every task.
    browserMode: ['perfil-propio', 'perfil-real', 'sin-navegador'].includes(config.browserMode) ? config.browserMode : null,
    browserProfileDir: typeof config.browserProfileDir === 'string' && config.browserProfileDir !== '' ? config.browserProfileDir : null,
    // Absent: `own-profile` uses a throwaway profile, exactly as it always did.
    ownProfileDir: typeof config.ownProfileDir === 'string' && config.ownProfileDir !== '' ? config.ownProfileDir : null,
    // These four were read by the browser service but never handed to it, so the
    // ports, the browser path and the snapshot limits were not configurable at all.
    browserPorts: Array.isArray(config.browserPorts) && config.browserPorts.length > 0 ? config.browserPorts : undefined,
    browserExecutable: typeof config.browserExecutable === 'string' && config.browserExecutable !== '' ? config.browserExecutable : undefined,
    maxElements: Number.isSafeInteger(config.maxElements) && config.maxElements > 0 ? config.maxElements : 60,
    maxTextChars: Number.isSafeInteger(config.maxTextChars) && config.maxTextChars > 0 ? config.maxTextChars : 2500,
  }

  // One PowerShell per session, kept warm: paying the startup once (and in the
  // in the background) is the difference between 8-22 s and milliseconds per action.
  const server = new ComputerServer(scriptPath, resolvePwsh(), childTimeout(resolved.timeoutMs))
  // Browser control over CDP: the fast, deterministic path for web work.
  const browser = createBrowserService(resolved)
  if (resolved.persistentShell) {
    // Arranque anticipado: mientras el modelo piensa, el servidor se calienta.
    setTimeout(() => {
      try {
        server.ensureStarted()
      } catch {
        /* the single-process fallback covers a server that will not start */
      }
    }, 0).unref?.()
  }

  ctx.on('dispose', () => {
    server.stop()
    browser.service.stop()
  })

  // A server must not outlive its host: if the DSH process ends
  // sin desmontar el plugin (salida brusca, cierre de la aplicacion), el hijo se
  // closes with it. Without this a live PowerShell would be left waiting for requests
  // ya nadie va a mandar.
  const stopOnExit = () => {
    server.stop()
    browser.service.stop()
  }
  process.once('exit', stopOnExit)
  process.once('beforeExit', stopOnExit)

  /**
   * Sends one request to the runner: first to the persistent server and, if that
   * path fails, to a fresh process. It never leaves the action untried.
   * @param request - request object.
   * @param signal - call cancellation.
   * @returns the runner response.
   */
  async function runNative(request, signal) {
    const timeoutMs = childTimeout(resolved.timeoutMs)
    if (!resolved.persistentShell) return runNativeOneShot(request, timeoutMs, signal)
    try {
      return await server.request(request, request.action)
    } catch (error) {
      if (signal?.aborted === true) throw error
      server.stop()
      try {
        return runNativeOneShot(request, timeoutMs, signal)
      } catch (fallbackError) {
        throw new Error(`${error.message}; the single-process fallback failed too: ${fallbackError.message}`)
      }
    }
  }

  // Compiled to raw JSON Schema: the author-form `required: true` per property
  // would otherwise reach the provider as a boolean where an array is expected.
  const actionSchema = compileParameters({
      action: {
        type: 'string',
        enum: ACTIONS,
        required: true,
        description: 'Action to run.',
      },
      x: POINT_FIELDS.x,
      y: POINT_FIELDS.y,
      space: POINT_FIELDS.space,
      frame: POINT_FIELDS.frame,
      x2: ACTION_SPECS.drag.parameters.x2,
      y2: ACTION_SPECS.drag.parameters.y2,
      amount: ACTION_SPECS.scroll.parameters.amount,
      horizontal: ACTION_SPECS.scroll.parameters.horizontal,
      text: ACTION_SPECS.type.parameters.text,
      delayMs: ACTION_SPECS.type.parameters.delayMs,
      key: ACTION_SPECS.key.parameters.key,
      keys: ACTION_SPECS.keys.parameters.keys,
      title: ACTION_SPECS.focus_window.parameters.title,
      app: ACTION_SPECS.start_app.parameters.app,
      handle: ACTION_SPECS.focus_window.parameters.handle,
      ms: ACTION_SPECS.wait.parameters.ms,
      maxWidth: ACTION_SPECS.screenshot.parameters.maxWidth,
      maxHeight: ACTION_SPECS.screenshot.parameters.maxHeight,
      captureAfter: {
        type: 'boolean',
        description: 'Requests a fresh capture in the same call, useful to see the effect of click/type/key without spending another turn.',
      },
  })

  /** Plain text for the actions that return no image. */
  function textOnly(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }

/**
 * Registers the `browser` tool: Chrome or Edge over CDP.
 *
 * Content blocks wait here, keyed by execution, because the registry validates the
 * value a tool returns against `output.schema` with `additionalProperties: false`:
 * a `content` inside that value invalidates the whole result and the model
 * receives nothing.
 *
 * @param ctx - plugin context.
 * @param browser - the browser service and its action executor.
 */
function registerBrowserTool(ctx, browser) {
  ctx.tools.register({
    name: 'browser',
    description: browserDescription(),
    parameters: browserParameters(),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          result: { type: 'object', additionalProperties: true },
        },
        required: ['action', 'result'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? JSON.stringify(value.result, null, 2) }],
      presentationMeta: (args, value) => ({ action: args?.action ?? value.action }),
    },
    timeoutMs: Math.max(resolved.timeoutMs, 60000),
    isConcurrencySafe: () => false,
    presentCall(args) {
      return { card: 'generic', title: `Browser: ${args?.action ?? 'action'}` }
    },
    finalizeContent(exec) {
      const content = browserContent.get(exec)
      if (content === undefined) return undefined
      browserContent.delete(exec)
      return content
    },
    async execute(args, exec) {
      const action = args.action
      // The browser capture also requires that the model can see images.
      if (action === 'screenshot') await assertImageCapableRoute(ctx, exec, action)
      const outcome = await browser.execute(ctx, args)
      if (outcome.image !== undefined) {
        browserContent.set(exec, [
          { type: 'text', text: `tab capture: ${outcome.image.width}x${outcome.image.height} px` },
          { type: 'image', attachment: outcome.image },
        ])
      }
      return { action, result: { ...outcome.result, ...(outcome.text === undefined ? {} : { text: outcome.text }) } }
    },
  })
}

  registerBrowserTool(ctx, browser)
  registerComputerTool(ctx, resolved, runNative, actionSchema)
}

/**
 * Compiles an author-form parameter map into raw JSON Schema.
 *
 * The action tables declare `required: true` per property, which is the author
 * shape DSH's own `defineTool` compiles. This plugin registers its tools
 * directly, so it has to do that compilation itself: sending the author shape
 * straight to the provider puts a boolean where the schema wants an array of
 * names, and the provider rejects the whole tool list — every turn fails with
 * `Invalid schema for function 'x': true is not of type "array"`. That is not a
 * degraded action, it is a dead session.
 *
 * Two deliberate choices:
 *
 * 1. The author-only `required` key is stripped from every property, so nothing
 *    boolean survives on the wire.
 * 2. Only `alwaysRequired` (just `action`) is required at the root. A dispatcher's
 *    parameter map carries every action's fields at once, so requiring all of them
 *    would demand `x` and `y` for a screenshot and `app` for a click. Each action's
 *    own requirements are enforced at execution time, with a clear error, and its
 *    description says what it needs.
 *
 * @param properties - author-form parameter map.
 * @param alwaysRequired - parameter names required for every call.
 * @returns a raw JSON Schema object node.
 */
function compileParameters(properties, alwaysRequired = ['action']) {
  const compiled = {}
  for (const [name, field] of Object.entries(properties)) {
    const { required, ...rest } = field
    void required
    compiled[name] = rest
  }
  const required = alwaysRequired.filter((name) => Object.hasOwn(compiled, name))
  return {
    type: 'object',
    additionalProperties: false,
    properties: compiled,
    ...required.length > 0 ? { required } : {},
  }
}

/**
 * Registers the `computer` tool: the desktop with real vision.
 *
 * `finalizeContent` is the key piece. The registry validates the value `execute`
 * returns against `output.schema` with `additionalProperties: false`, so a
 * `content` inside the value invalidates the whole result and the model receives
 * nothing. The content - image included - is attached afterwards, from here.
 *
 * @param ctx - plugin context.
 * @param resolved - resolved configuration.
 * @param runNative - native runner executor (persistent server or single process).
 * @param actionSchema - dispatcher parameter schema.
 */
function registerComputerTool(ctx, resolved, runNative, actionSchema) {
  const pendingComputerContent = new WeakMap()

  /**
   * Records one execution's content and returns the validatable value.
   * @param exec - execution context used as the key.
   * @param content - content blocks (text and image).
   * @param value - value validated against the output schema.
   * @returns the validatable value.
   */
  function deliver(exec, content, value) {
    if (Array.isArray(content) && content.length > 0) pendingComputerContent.set(exec, content)
    return value
  }

  ctx.tools.register({
    name: 'computer',
    description: buildDescription(),
    parameters: actionSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          result: { type: 'object', additionalProperties: true },
        },
        required: ['action', 'result'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result, null, 2) }],
      presentationMeta: (args, value) => ({ action: args?.action ?? value.action }),
    },
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return { card: 'generic', title: `Computer: ${args?.action ?? 'action'}` }
    },
    finalizeContent(exec) {
      const content = pendingComputerContent.get(exec)
      if (content === undefined) return undefined
      pendingComputerContent.delete(exec)
      return content
    },
    async execute(args, exec) {
      const action = args.action
      if (typeof action !== 'string' || !Object.hasOwn(ACTION_SPECS, action)) throw new Error(`computer: unknown action ${JSON.stringify(action)}`)

      // Optional brake: only the actions the deployment marks as sensitive.
      if (resolved.requireApprovalFor.includes(action)) await assertApproved(ctx, exec, action)

      // Actions that return an image go through the vision gate, the same as read_image.
      if (action === 'screenshot') await assertImageCapableRoute(ctx, exec, action)

      const request = { action }
      applyArguments(action, args, request, resolved)

      // Pointer actions may be expressed in the space of the capture the model just
      // looked at, which is the default. Translate them onto the desktop before the
      // runner sees them, using the frame mapping recorded by that capture.
      if (POINTER_ACTIONS.has(action)) {
        const record = computerFrames.get(args.frame)
        const from = toScreen(args, record)
        request.x = from.x
        request.y = from.y
        if (action === 'drag') {
          const to = toScreen({ x: args.x2, y: args.y2, space: args.space, frame: args.frame }, record)
          request.x2 = to.x
          request.y2 = to.y
        }
      }

      const wantsShot = args.captureAfter === true
        || (args.captureAfter !== false && resolved.captureAfterActions && action !== 'wait' && action !== 'cursor' && action !== 'windows')
      if (wantsShot) {
        request.captureAfter = true
        request.maxWidth = Number.isInteger(args.maxWidth) ? args.maxWidth : resolved.maxWidth
        request.maxHeight = Number.isInteger(args.maxHeight) ? args.maxHeight : resolved.maxHeight
        await assertImageCapableRoute(ctx, exec, action)
      }

      const outcome = await runNative(request, exec.signal)

      // A screenshot IS the image, so it gets its own branch: the capture is
      // attached even when captureAfterActions is off. Without this the runner
      // captures and the result falls through to the text path, and the model
      // receives a description of a picture it never sees. That happened.
      if (action === 'screenshot') {
        const content = await captureContent(ctx, outcome, 'screenshot of the virtual desktop')
        return deliver(exec, content, {
          action,
          result: {
            ok: true,
            frame: outcome.frame,
            path: outcome.path,
            image: outcome.image,
            screen: outcome.screen,
            scale: outcome.scale,
            ms: outcome.ms,
          },
        })
      }

      if (wantsShot && outcome.screenshot !== undefined) {
        const content = await captureContent(ctx, outcome.screenshot, `result of ${action}:`)
        return deliver(exec, content, {
          action,
          result: {
            ok: true,
            action,
            outcome: outcome.outcome,
            screenshot: { frame: outcome.screenshot.frame, path: outcome.screenshot.path, image: outcome.screenshot.image, screen: outcome.screenshot.screen, scale: outcome.screenshot.scale },
          },
        })
      }
      return deliver(exec, [{ type: 'text', text: JSON.stringify(outcome, null, 2) }], { action, result: { ok: true, action, outcome } })
    },
  })
}

/**
 * Copies each action's own arguments into the native request, validating what the
 * model is not allowed to get wrong.
 *
 * @param action - requested action.
 * @param args - model arguments.
 * @param request - request to be sent to the runner.
 * @param resolved - resolved configuration.
 */
function applyArguments(action, args, request, resolved) {
  if (action === 'screenshot') {
    request.maxWidth = Number.isInteger(args.maxWidth) ? args.maxWidth : resolved.maxWidth
    request.maxHeight = Number.isInteger(args.maxHeight) ? args.maxHeight : resolved.maxHeight
  }
  if (action === 'type') {
    if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('computer: type needs text')
    request.text = args.text
    request.delayMs = Number.isInteger(args.delayMs) ? args.delayMs : resolved.typeDelayMs
  }
  if (action === 'key') {
    if (typeof args.key !== 'string' || args.key.trim() === '') throw new Error('computer: key needs a key name')
    request.key = args.key
  }
  if (action === 'keys') {
    const keys = Array.isArray(args.keys) ? args.keys : []
    if (keys.length === 0) throw new Error('computer: keys needs a non-empty list')
    if (keys.some((entry) => typeof entry !== 'string')) throw new Error('computer: keys accepts key names only')
    request.keys = keys
  }
  if (action === 'scroll') {
    request.amount = Number.isInteger(args.amount) ? args.amount : 3
    request.horizontal = args.horizontal === true
  }
  if (action === 'focus_window' || action === 'close_window') {
    if (typeof args.title === 'string') request.title = args.title
    if (Number.isInteger(args.handle)) request.handle = args.handle
  }
  if (action === 'start_app') {
    if (typeof args.app !== 'string' || args.app.trim() === '') throw new Error('computer: start_app needs app')
    request.app = args.app
  }
  if (action === 'wait' && Number.isInteger(args.ms)) request.ms = args.ms
}

/**
 * Builds the `browser` dispatcher parameter schema.
 * @returns an author-form schema, with per-property `required`.
 */
function browserParameters() {
  const properties = {
    action: {
      type: 'string',
      enum: Object.keys(BROWSER_ACTIONS),
      required: true,
      description: 'Action to run.',
    },
  }
  for (const spec of Object.values(BROWSER_ACTIONS)) {
    for (const [key, field] of Object.entries(spec.parameters)) {
      if (properties[key] === undefined) properties[key] = field
    }
  }
  return compileParameters(properties)
}
