/**
 * Control de navegador por CDP: la via rapida y determinista frente a los
 * pixeles.
 *
 * Mirar una captura y estimar coordenadas cuesta una inferencia visual grande y
 * es aproximado. Leer la estructura de la pagina cuesta un texto pequeno y es
 * exacto: los elementos traen a que se refieren, y las acciones se ejecutan por
 * referencia o selector, no por coordenadas adivinadas.
 *
 * La captura sigue existiendo, pero para lo que solo la vista responde.
 *
 * @module dsh-tool-computer/browser
 */
import { join } from 'node:path'
import { BrowserConnection, DEFAULT_PORTS, findBrowser } from './cdp.js'

/**
 * Perfil por defecto de Chrome en Windows, para la via del perfil real.
 * Chrome no abre dos instancias del mismo perfil, asi que esa via exige cerrar
 * Chrome antes.
 */
export const DEFAULT_USER_DATA_DIR = join(
  process.env.LOCALAPPDATA ?? '',
  'Google',
  'Chrome',
  'User Data',
)

/** Las tres vias de navegador, con lo que implica cada una. */
export const BROWSER_MODES = [
  {
    id: 'perfil-propio',
    label: 'Perfil propio (recomendado)',
    description: 'Chrome se abre con un perfil nuevo y aislado: no toca tus pestanas, sesiones ni contrasenas. Hay que iniciar sesion en la plataforma una vez.',
  },
  {
    id: 'perfil-real',
    label: 'Mi Chrome real',
    description: 'Usa tu perfil de siempre, con tus sesiones ya abiertas. Requiere cerrar Chrome antes. Todo lo que veas en ese navegador queda visible para el agente.',
  },
  {
    id: 'sin-navegador',
    label: 'Sin navegador',
    description: 'El agente no toca el navegador en absoluto. Para banca, tramites personales o cualquier cosa que no quieras exponer.',
  },
]

/** Error que pide al modelo preguntar al usuario que via usar. */
export class BrowserModeRequired extends Error {
  /**
   * @param reason - por que hace falta la eleccion.
   */
  constructor(reason) {
    const options = BROWSER_MODES.map((mode) => `"${mode.id}" (${mode.label})`).join(', ')
    super([
      `browser: ${reason}`,
      'Antes de usar el navegador, pregunta al usuario que via quiere para ESTA tarea con ask_user_question, y repite su respuesta en el parametro `mode` de cada llamada:',
      ...BROWSER_MODES.map((mode) => `  - ${mode.id}: ${mode.description}`),
      `Opciones validas: ${options}.`,
      'No elijas por tu cuenta, y no reutilices la eleccion de una tarea anterior: el compartimento puede cambiar de una tarea a otra.',
    ].join('\n'))
    this.name = 'BrowserModeRequired'
  }
}

/**
 * Resuelve como conectar el navegador segun la via elegida.
 *
 * @param declaredMode - via que pidio el modelo en esta llamada.
 * @param config - configuracion resuelta del plugin.
 * @returns la configuracion de conexion y la via efectiva.
 */
export function resolveBrowserMode(declaredMode, config) {
  const mode = declaredMode ?? config.browserMode
  if (mode === undefined || mode === null) {
    throw new BrowserModeRequired('esta llamada no declaro que via de navegador usar')
  }
  if (!BROWSER_MODES.some((entry) => entry.id === mode)) {
    throw new Error(`browser: via desconocida ${JSON.stringify(mode)}; validas: ${BROWSER_MODES.map((entry) => entry.id).join(', ')}`)
  }
  if (mode === 'sin-navegador') {
    throw new Error('browser: el usuario eligio la via "sin-navegador" para esta tarea, asi que no toco el navegador. Si la tarea necesita el navegador, preguntale de nuevo que via quiere.')
  }
  const base = {
    ports: Array.isArray(config.browserPorts) && config.browserPorts.length > 0 ? config.browserPorts : DEFAULT_PORTS,
    executable: typeof config.browserExecutable === 'string' && config.browserExecutable !== '' ? config.browserExecutable : undefined,
    maxElements: Number.isSafeInteger(config.maxElements) && config.maxElements > 0 ? config.maxElements : 60,
    maxTextChars: Number.isSafeInteger(config.maxTextChars) && config.maxTextChars > 0 ? config.maxTextChars : 2500,
  }
  // `perfil-propio` deja userDataDir sin definir: cdp.js crea uno temporal y lo
  // borra al cerrar. `perfil-real` apunta al perfil de siempre.
  return mode === 'perfil-real'
    ? { ...base, userDataDir: config.browserProfileDir ?? DEFAULT_USER_DATA_DIR, mode }
    : { ...base, mode }
}

/** Etiquetas y roles que cuentan como interactivos. */
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
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Extrae el estado legible de la pagina: elementos interactivos indexados, texto
 * visible y avisos de estado.
 *
 * El indice es la unidad de trabajo del modelo: pide `snapshot`, lee `e12`, y
 * luego actua sobre `e12` sin tener que inventar un selector ni una coordenada.
 *
 * @param maxElements - cuantos elementos devolver como maximo.
 * @param maxTextChars - cuantos caracteres de texto visible incluir.
 * @returns el estado de la pagina.
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
    if (type) entry.type = type
    if (el.disabled) entry.disabled = true
    if (el.checked !== undefined) entry.checked = el.checked
    if (el.value !== undefined && typeof el.value === 'string' && el.value !== '') entry.value = el.value.slice(0, 80)
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
  // La pagina puede estar a medio cargar: sin <html> no hay scroll que medir.
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
 * Resuelve un elemento por referencia de snapshot o por selector CSS y lo trae a
 * la vista.
 *
 * @param ref - referencia tipo `e12` del ultimo snapshot.
 * @param selector - selector CSS, alternativa a la referencia.
 * @returns la posicion del elemento y como se resolvio.
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
    if (!index) return { error: 'no hay snapshot en esta pagina; llama a browser snapshot primero' }
    for (const [node, id] of index) if (id === ref) { el = node; how = 'ref'; break }
    if (!el) return { error: 'la referencia ' + ref + ' ya no existe: la pagina cambio. Toma un snapshot nuevo' }
  } else if (selector) {
    el = document.querySelector(selector)
    if (!el) return { error: 'ningun elemento coincide con el selector ' + selector }
    how = 'selector'
  } else {
    return { error: 'necesito ref o selector' }
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return { error: 'el elemento no tiene area visible' }
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

/** La sesion de navegador vive a nivel del plugin: se comparte entre llamadas. */
export class BrowserService {
  /**
   * @param config - configuracion resuelta del plugin.
   */
  constructor(config) {
    this.config = config
    this.connection = null
    this.activeMode = null
    /** Referencias resueltas por accion, para que un clic sea deterministico. */
    this.stash = new Map()
  }

  /**
   * Conecta (o lanza) el navegador segun la via elegida.
   *
   * Si la via cambio respecto a la conexion viva, la anterior se cierra: no se
   * reutiliza un navegador abierto con otro perfil, porque eso mezclaria
   * compartimentos que el usuario separo a proposito.
   *
   * @param declaredMode - via pedida en esta llamada, o undefined para usar la configurada.
   * @returns informacion de la conexion.
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
   * Ejecuta una expresion en la pagina, reenganchandose si la pestana cambio.
   * @param expression - expresion JavaScript.
   * @param declaredMode - via pedida en esta llamada.
   * @returns su valor.
   */
  async evaluate(expression, declaredMode) {
    await this.connect(declaredMode)
    await this.connection.ensureAlive()
    return await this.connection.session.evaluate(expression)
  }

  /**
   * Toma un snapshot de la pagina actual.
   * @param declaredMode - via pedida en esta llamada.
   * @returns estado legible de la pagina.
   */
  async snapshot(declaredMode) {
    const raw = await this.evaluate(snapshotExpression(this.config.maxElements, this.config.maxTextChars), declaredMode)
    if (raw === undefined || raw === null) throw new Error('la pagina no devolvio estado')
    return raw
  }

  /**
   * Resuelve una referencia o selector a una posicion en pantalla.
   * @param ref - referencia del snapshot.
   * @param selector - selector CSS.
   * @param declaredMode - via pedida en esta llamada.
   * @returns posicion y datos del elemento.
   */
  async resolve(ref, selector, declaredMode) {
    const found = await this.evaluate(resolveExpression(ref, selector), declaredMode)
    if (found?.error !== undefined) throw new Error(found.error)
    if (found === undefined || found === null) throw new Error('no pude resolver el elemento')
    return found
  }

  /**
   * Hace clic con el raton del navegador en una posicion de la pagina.
   * @param x - coordenada X en pixeles CSS.
   * @param y - coordenada Y en pixeles CSS.
   * @param button - boton del raton.
   * @param clickCount - 1 para clic simple, 2 para doble.
   */
  async clickAt(x, y, button = 'left', clickCount = 1) {
    const session = this.connection.session
    const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons, clickCount })
  }

  /**
   * Escribe texto en el elemento enfocado usando la entrada del navegador, que
   * respeta el framework de la pagina.
   * @param text - texto a escribir.
   */
  async insertText(text) {
    await this.connection.session.send('Input.insertText', { text })
  }

  /**
   * Pulsa una tecla del navegador.
   * @param key - nombre de la tecla.
   * @param modifiers - modificadores activos (alt=1, ctrl=2, meta=4, shift=8).
   */
  async pressKey(key, modifiers = 0) {
    const session = this.connection.session
    const code = KEY_CODES[key]
    if (code === undefined) throw new Error(`tecla no soportada por el navegador: ${key}`)
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: code.key, code: code.code, windowsVirtualKeyCode: code.vk, nativeVirtualKeyCode: code.vk, modifiers })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: code.key, code: code.code, windowsVirtualKeyCode: code.vk, nativeVirtualKeyCode: code.vk, modifiers })
  }

  /**
   * Captura la pestana como PNG.
   * @param fullPage - capturar la pagina entera o solo la vista.
   * @returns los bytes de la imagen.
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
   * Navega a una direccion, esperando a que la carga se asiente.
   * @param url - direccion destino.
   * @param timeoutMs - cuanto esperar a la carga.
   * @returns el estado de la pagina tras cargar.
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
   * Espera a que aparezca un texto o un selector.
   * @param options - texto, selector y limite.
   * @returns si aparecio y cuanto tardo.
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

  /** Cierra la conexion y el navegador que hayamos lanzado. */
  stop() {
    this.stash.clear()
    this.connection?.stop()
    this.connection = null
    this.activeMode = null
  }
}

/**
 * Teclas que la herramienta de navegador sabe pulsar, con su codigo virtual de
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
