/**
 * Cliente minimo de Chrome DevTools Protocol.
 *
 * Habla CDP por el `WebSocket` que trae Node desde la 22, asi que no hace falta
 * Playwright, Puppeteer ni el paquete `ws`: cero dependencias para controlar el
 * navegador de forma determinista.
 *
 * Se conecta a un Chrome ya abierto con depuracion remota o lanza uno nuevo, se
 * adjunta a una pestana, y expone `send()` sobre una sesion plana.
 *
 * @module dsh-tool-computer/cdp
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Puertos que se prueban, en orden, para encontrar un navegador depurable. */
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
 * Busca el ejecutable del navegador.
 * @param preferred - ruta explicita, si el despliegue la configura.
 * @returns ruta absoluta, o undefined si no hay ninguno.
 */
export function findBrowser(preferred) {
  const candidates = preferred === undefined ? BROWSER_CANDIDATES : [preferred, ...BROWSER_CANDIDATES]
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Pregunta a un puerto si hay un navegador depurable detras.
 * @param port - puerto a probar.
 * @param timeoutMs - limite de la peticion.
 * @returns la version anunciada, o undefined.
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
 * Espera a que un navegador recien lanzado publique su endpoint.
 *
 * Chrome tarda en publicar el puerto cuando arranca con un perfil que acaba de
 * usarse, asi que se espera con holgura y se comprueba varias veces.
 *
 * @param port - puerto esperado.
 * @param timeoutMs - cuanto esperar.
 * @returns la version anunciada.
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
  throw new Error(`el navegador no publico su endpoint de depuracion en el puerto ${port} tras ${timeoutMs} ms; puede haber otra instancia usando ese puerto, prueba con browserPorts: [9223]`)
}

/**
 * Comprueba si un perfil de Chrome parece estar en uso.
 *
 * Chrome bloquea su perfil con un archivo `lockfile` y un `SingletonLock`
 * mientras corre, y no permite una segunda instancia sobre el mismo perfil. En
 * vez de esperar 45 segundos a un endpoint que no va a llegar, se avisa al
 * instante con la instruccion util: cerrar Chrome.
 *
 * @param profileDir - ruta del perfil.
 * @returns si hay un bloqueo activo.
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
 * Una sesion CDP sobre una pestana concreta.
 *
 * Se conecta al WebSocket **de la pestana**, no al del navegador: asi los
 * comandos van directos, sin `sessionId` y sin enrutado por target. Desde la
 * pestana siguen funcionando los dominios del navegador que hacen falta
 * (`Target`, `Browser`).
 */
export class CdpSession {
  /**
   * @param socket - WebSocket ya abierto a la pestana.
   * @param target - informacion de la pestana.
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
        waiting.reject(new Error('la conexion con el navegador se cerro'))
      }
      this.pending.clear()
    })
  }

  /**
   * Envia un comando CDP y espera su resultado.
   * @param method - nombre del comando, p. ej. `Page.navigate`.
   * @param params - parametros del comando.
   * @param timeoutMs - limite.
   * @returns el resultado del comando.
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
   * Evalua una expresion en la pagina y devuelve su valor.
   * @param expression - expresion JavaScript.
   * @param timeoutMs - limite.
   * @returns el valor devuelto, ya deserializado.
   */
  async evaluate(expression, timeoutMs = 20000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs)
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'error en la pagina'
      throw new Error(`la pagina lanzo un error: ${text.slice(0, 300)}`)
    }
    return result.result?.value
  }
}

/** Un navegador bajo control: su proceso (si lo lanzamos) y la sesion activa. */
export class BrowserConnection {
  /**
   * @param config - puertos, ejecutable y perfil con los que conectar o lanzar.
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
   * Conecta a un navegador depurable o lanza uno.
   *
   * Si un puerto esta ocupado por un navegador que no responde (una instancia
   * zombi de una sesion anterior), se prueba el siguiente antes de darse por
   * vencido: quedarse clavado en el primer puerto deja la herramienta inservible.
   *
   * @returns informacion de la conexion.
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
        // El lanzamiento fallo: no dejes el proceso ni el perfil colgando.
        this.stop()
      }
    }
    throw lastError ?? new Error(`ningun puerto de ${this.config.ports.join(', ')} quedo disponible para el navegador`)
  }

  /**
   * Se conecta al WebSocket de la pestana activa y habilita los dominios que usa
   * la herramienta.
   * @param port - puerto del endpoint de depuracion.
   */
  async attach(port) {
    this.port = port
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    this.browserInfo = version.Browser ?? 'navegador'
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((target) => target.type === 'page')
    if (page === undefined) throw new Error('el navegador no tiene ninguna pestana de tipo page')
    this.socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true })
      this.socket.addEventListener('error', () => reject(new Error(`no pude abrir el WebSocket de depuracion en el puerto ${port}`)), { once: true })
    })
    this.session = new CdpSession(this.socket, page)
    await this.session.send('Page.enable')
    await this.session.send('Runtime.enable')
  }

  /** Verifica que la conexion sigue viva y, si no, vuelve a engancharse. */
  async ensureAlive() {
    if (this.session === null) return
    try {
      await this.session.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 4000)
      return
    } catch {
      /* la pestana se cerro o navego a otro proceso: reenganchar */
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
   * Lista las pestanas abiertas.
   * @returns pestanas con id, titulo y url.
   */
  async listTargets() {
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()
    return targets
      .filter((target) => target.type === 'page')
      .map((target) => ({ id: target.id, title: target.title, url: target.url }))
  }

  /**
   * Abre una pestana nueva y se engancha a ella.
   * @param url - direccion a cargar.
   * @returns la pestana creada.
   */
  async openTab(url = 'about:blank') {
    const created = await (await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    if (created?.id === undefined) throw new Error('el navegador no devolvio la pestana nueva')
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

  /** Cierra el navegador lanzado por nosotros y limpia el perfil temporal. */
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
      // Chrome es un arbol de procesos: matar solo la raiz deja vivos a los
      // hijos (renderers, GPU, utilidades), que siguen ocupando el perfil. El
      // `/T` cierra el arbol entero y el `/F` evita que un hijo atascado
      // sobreviva al intento.
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
      } catch {
        /* taskkill no disponible: se intenta el cierre normal */
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
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      } catch {
        // El sistema puede tardar en soltar el perfil tras matar el arbol; no es
        // un error, y el temporizador no impide que el proceso salga.
        try {
          setTimeout(() => {
            try {
              rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
            } catch {
              /* queda como basura inerte en el temporal */
            }
          }, 2000).unref?.()
        } catch {
          /* sin temporizador: queda la basura inerte */
        }
      }
    }
  }
}

export { DEFAULT_PORTS }
