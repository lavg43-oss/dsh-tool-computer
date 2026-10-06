/**
 * Browser control over CDP: the fast, deterministic path instead of
 * pixeles.
 *
 * Looking at a capture and estimating coordinates costs a large visual inference
 * is approximate. Reading the page structure costs a small text and is
 * exact: elements carry what they refer to, and actions run by
 * or selector, not by guessed coordinates.
 *
 * The capture still exists, but for what only the eye can answer.
 *
 * @module dsh-tool-computer/browser
 */
import { join } from 'node:path'
import { BrowserConnection, DEFAULT_PORTS, findBrowser } from './cdp.js'

/**
 * Default Chrome profile on Windows, for the real-profile mode.
 * Chrome does not open two instances of the same profile, so that mode requires
 * closing Chrome first.
 */
export const DEFAULT_USER_DATA_DIR = join(
  process.env.LOCALAPPDATA ?? '',
  'Google',
  'Chrome',
  'User Data',
)

/** The three browser modes, with what each one implies. */
export const BROWSER_MODES = [
  {
    id: 'own-profile',
    label: 'Own profile (recommended)',
    description: 'Chrome opens with a fresh, isolated profile: it touches none of your tabs, sessions or passwords. You log into the site once.',
  },
  {
    id: 'real-profile',
    label: 'My real Chrome',
    description: 'Uses your everyday profile, with your sessions already open. Requires closing Chrome first. Everything visible in that browser becomes visible to the agent.',
  },
  {
    id: 'no-browser',
    label: 'No browser',
    description: 'The agent does not touch the browser at all. For banking, personal paperwork, or anything you do not want exposed.',
  },
]

/**
 * The mode names accepted on the wire.
 *
 * The English names are canonical. The Spanish ones are kept as aliases because
 * this tool was first built for a Spanish-speaking user, and asking a human to
 * switch vocabulary mid-task is worse than accepting both.
 */
export const MODE_ALIASES = {
  'own-profile': 'own-profile',
  'perfil-propio': 'own-profile',
  'real-profile': 'real-profile',
  'perfil-real': 'real-profile',
  'no-browser': 'no-browser',
  'sin-navegador': 'no-browser',
}

/**
 * Normalize a mode name, accepting the canonical English name or its Spanish alias.
 * @param value - raw mode value from the model or the configuration.
 * @returns the canonical mode, or undefined when the value names none.
 */
export function normalizeMode(value) {
  if (typeof value !== 'string') return undefined
  return MODE_ALIASES[value.trim().toLowerCase()]
}

/** Error that asks the model to ask the user which mode to use. */
export class BrowserModeRequired extends Error {
  /**
   * @param reason - why the choice is needed.
   */
  constructor(reason) {
    const options = BROWSER_MODES.map((mode) => `"${mode.id}" (${mode.label})`).join(', ')
    super([
      `browser: ${reason}`,
      'Before using the browser, ask the user which mode they want for THIS task with ask_user_question, then repeat their answer in the `mode` parameter of every call:',
      ...BROWSER_MODES.map((mode) => `  - ${mode.id}: ${mode.description}`),
      `Valid options: ${options}.`,
      'Do not choose on your own, and do not reuse the choice from an earlier task: the compartment can change from one task to the next.',
    ].join('\n'))
    this.name = 'BrowserModeRequired'
  }
}

/**
 * Resolve how to connect the browser for the chosen mode.
 *
 * @param declaredMode - mode the model asked for in this call.
 * @param config - resolved plugin configuration.
 * @returns the connection configuration and the effective mode.
 */
export function resolveBrowserMode(declaredMode, config) {
  const mode = normalizeMode(declaredMode) ?? normalizeMode(config.browserMode)
  if (mode === undefined) {
    throw new BrowserModeRequired('this call did not declare which browser mode to use')
  }
  if (mode === 'no-browser') {
    throw new Error('browser: the user chose the "no-browser" mode for this task, so I will not touch the browser. If the task needs it, ask again which mode they want.')
  }
  const base = {
    ports: Array.isArray(config.browserPorts) && config.browserPorts.length > 0 ? config.browserPorts : DEFAULT_PORTS,
    executable: typeof config.browserExecutable === 'string' && config.browserExecutable !== '' ? config.browserExecutable : undefined,
    maxElements: Number.isSafeInteger(config.maxElements) && config.maxElements > 0 ? config.maxElements : 60,
    maxTextChars: Number.isSafeInteger(config.maxTextChars) && config.maxTextChars > 0 ? config.maxTextChars : 2500,
  }
  // `own-profile` leaves userDataDir unset: cdp.js creates a temporary profile and
  // removes it on close. `real-profile` points at the everyday profile.
  return mode === 'real-profile'
    ? { ...base, userDataDir: config.browserProfileDir ?? DEFAULT_USER_DATA_DIR, mode }
    : { ...base, mode }
}

/** Tags and roles that count as interactive. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  '[role=combobox]',
  '[role=textbox]',
  '[role=searchbox]',
  '[contenteditable=true]',
  '[contenteditable=""]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Extracts the readable state of the page: indexed interactive elements, visible
 * visible y avisos de estado.
 *
 * The index is the model's unit of work: it asks for `snapshot`, reads `e12`, and
 * then acts on `e12` without having to invent a selector or a coordinate.
 *
 * @param maxElements - how many elements to return at most.
 * @param maxTextChars - how many visible text characters to include.
 * @returns the page state.
 */
export function snapshotExpression(maxElements, maxTextChars) {
  return `(() => {
  const MAX_ELEMENTS = ${maxElements}
  const MAX_TEXT = ${maxTextChars}
  const hidden = (el) => {
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return true
    return el.getAttribute('aria-hidden') === 'true'
  }
  const label = (el) => {
    const raw = el.getAttribute('aria-label')
      || (el.labels && el.labels[0] && el.labels[0].innerText)
      || el.getAttribute('placeholder')
      || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : '')
      || el.innerText
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || ''
    return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 120)
  }
  const cssPath = (el) => {
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
    if (testId) return '[data-testid="' + testId + '"]'
    return null
  }
  const selector = ${JSON.stringify(INTERACTIVE_SELECTOR)}
  const elements = []
  const index = new Map()
  let counter = 0
  document.querySelectorAll(selector).forEach((el) => {
    if (elements.length >= MAX_ELEMENTS) return
    if (hidden(el)) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    counter += 1
    const ref = 'e' + counter
    index.set(el, ref)
    const entry = { ref, tag: el.tagName.toLowerCase(), label: label(el) }
    const type = el.getAttribute('type')
    if (type && type !== 'text') entry.type = type
    if (el.isContentEditable === true || el.getAttribute('contenteditable') !== null) entry.editable = true
    if (el.disabled) entry.disabled = true
    if (el.checked !== undefined) entry.checked = el.checked
    const value = el.isContentEditable === true ? (el.innerText ?? '') : el.value
    if (typeof value === 'string' && value.trim() !== '') entry.value = value.trim().slice(0, 120)
    const css = cssPath(el)
    if (css) entry.selector = css
    if (rect.bottom < 0 || rect.top > innerHeight) entry.offscreen = true
    if (rect.width < 24 || rect.height < 24) entry.small = true
    elements.push(entry)
  })
  window.__dshElements = index

  const active = document.activeElement
  const activeRef = active ? index.get(active) ?? null : null
  const root = document.body || document.documentElement
  const bodyText = (root ? root.innerText : '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim()
  // The page may be half loaded: with no <html> there is no scroll to measure.
  const scrolled = document.scrollingElement || document.documentElement
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollY: scrolled ? Math.round(scrolled.scrollTop) : 0,
      scrollHeight: scrolled ? scrolled.scrollHeight : 0,
    },
    focused: activeRef ? activeRef + ' <' + active.tagName.toLowerCase() + '>' : (active ? active.tagName.toLowerCase() : null),
    text: bodyText.slice(0, MAX_TEXT),
    truncated: bodyText.length > MAX_TEXT,
    elementCount: counter,
    elements,
  }
})()`
}

/**
 * Resolves an element by snapshot reference or CSS selector and brings it into
 * view.
 *
 * @param ref - `e12`-style reference from the last snapshot.
 * @param selector - CSS selector, an alternative to the reference.
 * @returns the element position and how it was resolved.
 */
export function resolveExpression(ref, selector) {
  const byRef = ref === undefined ? 'null' : JSON.stringify(ref)
  const bySelector = selector === undefined ? 'null' : JSON.stringify(selector)
  return `(() => {
  const ref = ${byRef}
  const selector = ${bySelector}
  let el = null
  let how = null
  if (ref) {
    const index = window.__dshElements
    if (!index) return { error: 'there is no snapshot on this page; call browser snapshot first' }
    for (const [node, id] of index) if (id === ref) { el = node; how = 'ref'; break }
    if (!el) return { error: 'reference ' + ref + ' no longer exists: the page changed. Take a new snapshot' }
  } else if (selector) {
    el = document.querySelector(selector)
    if (!el) return { error: 'no element matches the selector ' + selector }
    how = 'selector'
  } else {
    return { error: 'I need a ref or a selector' }
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return { error: 'the element has no visible area' }
  return {
    how,
    tag: el.tagName.toLowerCase(),
    label: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  }
})()`
}

/** The browser session lives at plugin level: it is shared across calls. */
export class BrowserService {
  /**
   * @param config - resolved plugin configuration.
   */
  constructor(config) {
    this.config = config
    this.connection = null
    this.activeMode = null
    /** References resolved per action, so a click is deterministic. */
    this.stash = new Map()
  }

  /**
   * Connects (or launches) the browser for the chosen mode.
   *
   * If the mode changed since the live connection, the previous one is closed: a
   * browser opened with another profile is never reused, because that would mix
   * compartments the user separated on purpose.
   *
   * @param declaredMode - mode requested in this call, or undefined to use the configured one.
   * @returns connection information.
   */
  async connect(declaredMode) {
    const resolved = resolveBrowserMode(declaredMode, this.config)
    if (this.connection !== null && this.activeMode !== resolved.mode) {
      this.connection.stop()
      this.connection = null
      this.stash.clear()
    }
    if (this.connection === null) {
      this.connection = new BrowserConnection(resolved)
      this.activeMode = resolved.mode
    }
    const info = await this.connection.ensureConnected()
    return { ...info, mode: resolved.mode }
  }

  /**
   * Runs an expression in the page, re-attaching if the tab changed.
   * @param expression - expresion JavaScript.
   * @param declaredMode - mode requested in this call.
   * @returns its value.
   */
  async evaluate(expression, declaredMode) {
    await this.connect(declaredMode)
    await this.connection.ensureAlive()
    return await this.connection.session.evaluate(expression)
  }

  /**
   * Takes a snapshot of the current page.
   * @param declaredMode - mode requested in this call.
   * @returns the readable page state.
   */
  async snapshot(declaredMode) {
    const raw = await this.evaluate(snapshotExpression(this.config.maxElements, this.config.maxTextChars), declaredMode)
    if (raw === undefined || raw === null) throw new Error('the page returned no state')
    return raw
  }

  /**
   * Resolves a reference or selector into a screen position.
   * @param ref - snapshot reference.
   * @param selector - selector CSS.
   * @param declaredMode - mode requested in this call.
   * @returns position and element data.
   */
  async resolve(ref, selector, declaredMode) {
    const found = await this.evaluate(resolveExpression(ref, selector), declaredMode)
    if (found?.error !== undefined) throw new Error(found.error)
    if (found === undefined || found === null) throw new Error('could not resolve the element')
    return found
  }

  /**
   * Clicks with the browser's own mouse at a position in the page.
   * @param x - coordenada X en pixeles CSS.
   * @param y - coordenada Y en pixeles CSS.
   * @param button - mouse button.
   * @param clickCount - 1 for a single click, 2 for a double.
   */
  async clickAt(x, y, button = 'left', clickCount = 1) {
    const session = this.connection.session
    const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons, clickCount })
  }

  /**
   * Types text into the focused element using the browser's own input, which
   * respects the page's framework.
   * @param text - text to type.
   */
  async insertText(text) {
    await this.connection.session.send('Input.insertText', { text })
  }

  /**
   * Presses a browser key.
   * @param key - key name.
   * @param modifiers - modificadores activos (alt=1, ctrl=2, meta=4, shift=8).
   */
  async pressKey(key, modifiers = 0) {
    const session = this.connection.session
    const code = KEY_CODES[key]
    if (code === undefined) throw new Error(`key not supported by the browser: ${key}`)
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: code.key, code: code.code, windowsVirtualKeyCode: code.vk, nativeVirtualKeyCode: code.vk, modifiers })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: code.key, code: code.code, windowsVirtualKeyCode: code.vk, nativeVirtualKeyCode: code.vk, modifiers })
  }

  /**
   * Captures the tab as a PNG.
   * @param fullPage - capture the whole page or just the viewport.
   * @returns the image bytes.
   */
  async screenshot(declaredMode, fullPage = false) {
    await this.connect(declaredMode)
    await this.connection.ensureAlive()
    const result = await this.connection.session.send('Page.captureScreenshot', {
      format: 'png',
      ...fullPage ? { captureBeyondViewport: true } : {},
    }, 30000)
    return Buffer.from(result.data, 'base64')
  }

  /**
   * Navigates to a URL, waiting for the load to settle.
   * @param url - direccion destino.
   * @param timeoutMs - how long to wait for the load.
   * @returns the page state after loading.
   */
  async navigate(url, declaredMode, timeoutMs = 20000) {
    await this.connect(declaredMode)
    await this.connection.ensureAlive()
    const session = this.connection.session
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs)
      const listener = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.method === 'Page.loadEventFired') {
          clearTimeout(timer)
          session.socket.removeEventListener('message', listener)
          resolve('loaded')
        }
      }
      session.socket.addEventListener('message', listener)
    })
    await session.send('Page.navigate', { url })
    await loaded
    return await this.snapshot(declaredMode)
  }

  /**
   * Waits for a text or a selector to appear.
   * @param options - text, selector and limit.
   * @returns whether it appeared, and how long it took.
   */
  async waitFor(options, declaredMode) {
    const started = Date.now()
    const deadline = started + options.timeoutMs
    const condition = options.text !== undefined
      ? `document.body && document.body.innerText.includes(${JSON.stringify(options.text)})`
      : `document.querySelector(${JSON.stringify(options.selector)}) !== null`
    while (Date.now() < deadline) {
      const found = await this.evaluate(`Boolean(${condition})`, declaredMode).catch(() => false)
      if (found === true) return { found: true, waitedMs: Date.now() - started }
      await new Promise((resolve) => setTimeout(resolve, Math.min(400, Math.max(100, Math.floor(options.timeoutMs / 20)))))
    }
    return { found: false, waitedMs: Date.now() - started }
  }

  /**
   * Waits until a region stops changing: the end of a streamed answer.
   *
   * Web chats answer by streaming tokens into the DOM, so "the answer is ready" is
   * not a text you can wait for — it is the moment the text stops growing. This
   * watches the length of a region and considers it settled once it has not
   * changed for `quietMs`.
   *
   * Two details that matter in practice:
   *
   * - The stream moves the length only up. A shrink means the model restarted or
   *   edited its answer, so the quiet clock restarts.
   * - A control that says "stop generating", or an `aria-busy` region, is a much
   *   stronger signal than a timer. When it is present the region is not settled,
   *   however long the text has been still.
   *
   * @param options - selector, quiet period and limit.
   * @param declaredMode - mode requested in this call.
   * @returns whether it settled, how long it waited, and the text length.
   */
  async waitForSettled(options, declaredMode) {
    const started = Date.now()
    const deadline = started + options.timeoutMs
    const selector = options.selector ?? 'body'
    const quietMs = Math.max(200, Math.min(options.quietMs ?? 1200, 30000))
    const probe = `(() => {
  const node = document.querySelector(${JSON.stringify(selector)})
  if (!node) return { exists: false }
  const text = (node.innerText || '').slice(0, 400000)
  const stop = document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i], [aria-label*="detener" i]')
  const busy = document.querySelector('[aria-busy="true"]')
  return { exists: true, length: text.length, pending: stop !== null || busy !== null }
})()`

    let previousLength = -1
    let lastChange = Date.now()
    let lastProbe = { exists: false, length: 0, pending: false }

    while (Date.now() < deadline) {
      let probeResult
      try {
        probeResult = await this.evaluate(probe, declaredMode)
      } catch {
        probeResult = undefined
      }
      if (probeResult !== undefined && probeResult !== null && probeResult.exists === true) {
        lastProbe = probeResult
        if (probeResult.length > previousLength) {
          previousLength = probeResult.length
          lastChange = Date.now()
        } else if (probeResult.length < previousLength) {
          // The answer was rewritten: start the quiet clock again.
          previousLength = probeResult.length
          lastChange = Date.now()
        }
        if (probeResult.pending === false && Date.now() - lastChange >= quietMs) {
          return { settled: true, waitedMs: Date.now() - started, chars: probeResult.length, sawStopControl: false }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    return {
      settled: false,
      waitedMs: Date.now() - started,
      chars: lastProbe.length ?? 0,
      stillGenerating: lastProbe.pending === true,
      hint: lastProbe.exists === false
        ? `no element matched ${JSON.stringify(selector)}, so there was nothing to watch`
        : 'it kept changing until the limit; call settle again to keep waiting',
    }
  }

  /** Closes the connection and the browser we launched. */
  stop() {
    this.stash.clear()
    this.connection?.stop()
    this.connection = null
    this.activeMode = null
  }
}

/**
 * Keys the browser tool can press, with their Windows virtual code and
 * Windows y su `code` de DOM.
 */
const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32 },
}

/** Modificadores de teclado de CDP. */
export const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

export { findBrowser }
