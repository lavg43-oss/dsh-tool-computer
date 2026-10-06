/**
 * Cliente minimo de Chrome DevTools Protocol.
 *
 * Speaks CDP over the `WebSocket` Node has shipped since 22, so no Playwright,
 * Puppeteer or `ws` package is needed: zero dependencies to drive the browser
 * deterministically.
 *
 * It connects to a Chrome already open with remote debugging, or launches a new
 * one, attaches to one tab, and exposes `send()` over a flat connection.
 *
 * @module dsh-tool-computer/cdp
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Ports tried in order, to find a debuggable browser. */
const DEFAULT_PORTS = [9222, 9223, 9224]

/** Rutas habituales de Chrome y Edge en Windows. */
const BROWSER_CANDIDATES = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]

/**
 * Finds the browser executable.
 * @param preferred - explicit path, when the deployment configures one.
 * @returns an absolute path, or undefined when there is none.
 */
export function findBrowser(preferred) {
  const candidates = preferred === undefined ? BROWSER_CANDIDATES : [preferred, ...BROWSER_CANDIDATES]
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Asks a port whether a debuggable browser is behind it.
 * @param port - puerto a probar.
 * @param timeoutMs - request limit.
 * @returns the announced version, or undefined.
 */
async function probePort(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const version = await response.json()
    return typeof version?.webSocketDebuggerUrl === 'string' ? { port, version } : undefined
  } catch {
    return undefined
  }
}

/**
 * Waits for a freshly launched browser to publish its endpoint.
 *
 * Chrome takes a while to publish the port when it starts with a profile that was
 * just used, so this waits generously and checks several times.
 *
 * @param port - expected port.
 * @param timeoutMs - how long to wait.
 * @returns the announced version.
 */
async function waitForPort(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts++
    const found = await probePort(port)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, attempts < 10 ? 300 : 1000))
  }
  throw new Error(`the browser did not publish its debugging endpoint on port ${port} after ${timeoutMs} ms; another instance may be using that port, try browserPorts: [9223]`)
}

/**
 * Checks whether a Chrome profile looks like it is in use.
 *
 * Chrome locks its profile with a `lockfile` and a `SingletonLock` while running,
 * and refuses a second instance over the same profile. Instead of waiting 45
 * seconds for an endpoint that will never answer, this warns immediately with the
 * useful instruction: close Chrome.
 *
 * @param profileDir - profile path.
 * @returns whether a lock is active.
 */
function profileLooksLocked(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return false
  const markers = ['SingletonLock', 'lockfile', 'SingletonCookie', 'SingletonSocket']
  for (const marker of markers) {
    if (existsSync(join(profileDir, marker))) return true
  }
  return false
}

/**
 * One CDP connection to one concrete tab.
 *
 * Connects to the **tab's** WebSocket, not the browser's: that way commands go
 * straight through, with no `sessionId` and no target routing. From the tab, the
 * browser domains that are needed (`Target`, `Browser`) still work.
 */
export class CdpSession {
  /**
   * @param socket - WebSocket already open to the tab.
   * @param target - tab information.
   */
  constructor(socket, target) {
    this.socket = socket
    this.target = target
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id === undefined) return
      const waiting = this.pending.get(message.id)
      if (waiting === undefined) return
      this.pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(`${message.error.message} (CDP ${message.error.code})`))
      else waiting.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const [, waiting] of this.pending) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error('the connection to the browser was closed'))
      }
      this.pending.clear()
    })
  }

  /**
   * Sends a CDP command and waits for its result.
   * @param method - command name, for example `Page.navigate`.
   * @param params - command parameters.
   * @param timeoutMs - limite.
   * @returns the command result.
   */
  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} no respondio en ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluates an expression in the page and returns its value.
   * @param expression - expresion JavaScript.
   * @param timeoutMs - limite.
   * @returns the returned value, already deserialized.
   */
  async evaluate(expression, timeoutMs = 20000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs)
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'error in the page'
      throw new Error(`the page threw an error: ${text.slice(0, 300)}`)
    }
    return result.result?.value
  }
}

/** A browser under control: its process (when we launched it) and the live connection. */
export class BrowserConnection {
  /**
   * @param config - ports, executable and profile to connect or launch with.
   */
  constructor(config) {
    this.config = config
    this.port = undefined
    this.child = null
    this.tempProfile = null
    this.socket = null
    this.session = null
    this.browserInfo = null
  }

  /**
   * Connects to a debuggable browser or launches one.
   *
   * If a port is taken by a browser that does not answer (a zombie instance from
   * an earlier session), the next one is tried before giving up: getting stuck on
   * the first port leaves the tool unusable.
   *
   * @returns connection information.
   */
  async ensureConnected() {
    if (this.session !== null) return { reused: true, port: this.port, browser: this.browserInfo }

    for (const port of this.config.ports) {
      const found = await probePort(port)
      if (found === undefined) continue
      await this.attach(port)
      return { reused: true, port, browser: this.browserInfo }
    }

    const executable = findBrowser(this.config.executable)
    if (executable === undefined) {
      throw new Error('no encontre Chrome ni Edge; configura browserExecutable con la ruta del ejecutable')
    }

    let lastError
    for (const port of this.config.ports) {
      if (await probePort(port, 700) !== undefined) continue
      if (this.config.userDataDir !== undefined && profileLooksLocked(this.config.userDataDir)) {
        throw new Error(`el perfil ${this.config.userDataDir} esta en uso: cierra Chrome (o el navegador que lo tenga abierto) y vuelve a intentarlo, o usa la via "perfil-propio" para no tocar tu navegador`)
      }
      const profileDir = this.config.userDataDir ?? mkdtempSync(join(tmpdir(), 'dsh-cdp-'))
      if (this.config.userDataDir === undefined) this.tempProfile = profileDir
      this.child = spawn(executable, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        'about:blank',
      ], { stdio: 'ignore', windowsHide: true })
      try {
        const found = await waitForPort(port)
        await this.attach(port)
        return { reused: false, port, browser: this.browserInfo, executable, profileDir, version: found.version.Browser }
      } catch (error) {
        lastError = error
        // The launch failed: do not leave the process or the profile dangling.
        this.stop()
      }
    }
    throw lastError ?? new Error(`none of the ports ${this.config.ports.join(', ')} was available for the browser`)
  }

  /**
   * Connects to the active tab's WebSocket and enables the domains the tool uses.
   * @param port - debugging endpoint port.
   */
  async attach(port) {
    this.port = port
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    this.browserInfo = version.Browser ?? 'browser'
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((target) => target.type === 'page')
    if (page === undefined) throw new Error('the browser has no target of type page')
    this.socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true })
      this.socket.addEventListener('error', () => reject(new Error(`no pude abrir el WebSocket de depuracion en el puerto ${port}`)), { once: true })
    })
    this.session = new CdpSession(this.socket, page)
    await this.session.send('Page.enable')
    await this.session.send('Runtime.enable')
  }

  /** Checks that the connection is still alive and, if not, attaches again. */
  async ensureAlive() {
    if (this.session === null) return
    try {
      await this.session.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 4000)
      return
    } catch {
      /* the tab closed or navigated into another process: re-attach */
    }
    try {
      this.socket?.close()
    } catch {
      /* ya estaba cerrada */
    }
    this.session = null
    this.socket = null
    await this.attach(this.port)
  }

  /**
   * Lists the open tabs.
   * @returns tabs with id, title and url.
   */
  async listTargets() {
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()
    return targets
      .filter((target) => target.type === 'page')
      .map((target) => ({ id: target.id, title: target.title, url: target.url }))
  }

  /**
   * Opens a new tab and attaches to it.
   * @param url - direccion a cargar.
   * @returns the created tab.
   */
  async openTab(url = 'about:blank') {
    const created = await (await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    if (created?.id === undefined) throw new Error('the browser did not return the new tab')
    try {
      this.socket?.close()
    } catch {
      /* ya estaba cerrada */
    }
    this.session = null
    this.socket = null
    await this.attach(this.port)
    return { id: created.id, url: created.url ?? url }
  }

  /** Closes the browser we launched and cleans up the temporary profile. */
  stop() {
    try {
      this.socket?.close()
    } catch {
      /* ya estaba cerrado */
    }
    this.socket = null
    this.session = null
    if (this.child !== null) {
      const pid = this.child.pid
      // Chrome is a process tree: killing only the root leaves the children
      // (renderers, GPU, utilities) alive, still holding the profile. `/T` closes
      // the whole tree and `/F` keeps a stuck child from surviving the attempt.
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
      } catch {
        /* taskkill unavailable: fall back to a normal close */
      }
      try {
        this.child.kill()
      } catch {
        /* ya habia muerto */
      }
      this.child = null
    }
    if (this.tempProfile !== null) {
      const profile = this.tempProfile
      this.tempProfile = null
      // The system may take a few seconds to release the profile after the tree is
      // killed, so this retries synchronously before giving up: an async timer
      // would be cut short when the host process exits, which is exactly how a
      // profile directory was left behind in testing.
      if (!removeProfile(profile)) {
        try {
          setTimeout(() => {
            removeProfile(profile)
          }, 3000).unref?.()
        } catch {
          /* no timer available: the inert litter stays */
        }
      }
    }
  }
}

/**
 * Removes a temporary Chrome profile, retrying while the system still holds it.
 *
 * @param profile - absolute profile path.
 * @returns whether the directory is gone.
 */
function removeProfile(profile) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
      if (!existsSync(profile)) return true
    } catch {
      /* still locked: wait and retry */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
  }
  return !existsSync(profile)
}

export { DEFAULT_PORTS }
