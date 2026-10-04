/**
 * dsh-tool-computer — computer use para DSH en Windows.
 *
 * Registra dos herramientas:
 *
 * - `computer`: control del escritorio con vision real (bloque `image` sobre
 *   `ctx.attachments`), clic, teclado, scroll y ventanas. El trabajo nativo lo
 *   hace `lib/computer.ps1`, que recibe un JSON por stdin y devuelve un JSON por
 *   stdout, en modo servidor persistente o en proceso unico.
 * - `browser`: control de Chrome o Edge por el protocolo de depuracion, sin
 *   dependencias. Lee la estructura de la pagina y actua por referencia en vez
 *   de estimar coordenadas: es la via rapida y determinista para trabajo web.
 *
 * @module dsh-tool-computer
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_ACTIONS, browserDescription, createBrowserService } from './lib/browser-tool.js'

/** Identidad estable de la fila del loader. */
export const name = 'tool-computer'

/**
 * Esquema de configuracion en la forma que Cordis consume: un objeto con
 * `~standard.validate`. Se escribe a mano para que el plugin no importe nada
 * de `@deepseek-ai/*` (el perfil no tiene esos paquetes en su node_modules).
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
    describe: `entero entre ${min} y ${max}`,
  }
}

const CONFIG_FIELDS = {
  maxWidth: integerField(1600, 320, 4096),
  maxHeight: integerField(1000, 240, 4096),
  typeDelayMs: integerField(8, 0, 500),
  timeoutMs: integerField(30000, 1000, 600000),
}

/** Acciones validas, duplicadas aqui para que el esquema de config las conozca sin depender de ACTION_SPECS. */
const CONFIG_ACTIONS = [
  'screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll',
  'type', 'key', 'keys', 'cursor', 'windows', 'focus_window', 'close_window', 'start_app', 'wait',
]

/** Config validada del plugin, mas los campos que no necesitan rango. */
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
          || Object.hasOwn(CONFIG_FIELDS, key)
        if (!known) issues.push({ message: `propiedad de configuracion desconocida: ${key}`, path: [key] })
      }
      if (Object.hasOwn(source, 'persistentShell') && typeof source.persistentShell !== 'boolean') {
        issues.push({ message: 'persistentShell debe ser booleano', path: ['persistentShell'] })
      }
      if (Object.hasOwn(source, 'browserMode') && !['perfil-propio', 'perfil-real', 'sin-navegador'].includes(source.browserMode)) {
        issues.push({ message: 'browserMode debe ser "perfil-propio", "perfil-real" o "sin-navegador"', path: ['browserMode'] })
      }
      if (Object.hasOwn(source, 'browserProfileDir') && source.browserProfileDir !== null && typeof source.browserProfileDir !== 'string') {
        issues.push({ message: 'browserProfileDir debe ser una ruta o null', path: ['browserProfileDir'] })
      }
      if (Object.hasOwn(source, 'captureAfterActions') && typeof source.captureAfterActions !== 'boolean') {
        issues.push({ message: 'captureAfterActions debe ser booleano', path: ['captureAfterActions'] })
      }
      if (Object.hasOwn(source, 'requireApprovalFor') && source.requireApprovalFor !== undefined && source.requireApprovalFor !== null) {
        if (!Array.isArray(source.requireApprovalFor)) {
          issues.push({ message: 'requireApprovalFor debe ser una lista de acciones', path: ['requireApprovalFor'] })
        } else {
          for (const [index, entry] of source.requireApprovalFor.entries()) {
            if (typeof entry !== 'string' || !CONFIG_ACTIONS.includes(entry)) {
              issues.push({ message: `requireApprovalFor[${index}] no es una accion valida: ${JSON.stringify(entry)}`, path: ['requireApprovalFor', index] })
            }
          }
        }
      }
      for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
        if (!Object.hasOwn(source, key) || source[key] === undefined || source[key] === null) continue
        if (!field.check(source[key])) issues.push({ message: `${key} debe ser un ${field.describe}`, path: [key] })
      }
      if (issues.length > 0) return { issues }
      const value = {
        captureAfterActions: source.captureAfterActions === true,
        persistentShell: source.persistentShell !== false,
        requireApprovalFor: Array.isArray(source.requireApprovalFor) ? [...source.requireApprovalFor] : [],
        // Sin valor, la eleccion se le pregunta al usuario en cada tarea.
        browserMode: ['perfil-propio', 'perfil-real', 'sin-navegador'].includes(source.browserMode) ? source.browserMode : null,
        browserProfileDir: typeof source.browserProfileDir === 'string' && source.browserProfileDir !== '' ? source.browserProfileDir : null,
      }
      for (const [key, field] of Object.entries(CONFIG_FIELDS)) value[key] = field.coerce(source[key])
      return { value }
    },
  },
}

/** Servicios requeridos: el registro de herramientas, el almacen de adjuntos y las rutas de modelo. */
export const inject = ['tools', 'attachments', 'llm']

/**
 * Pide autorizacion al usuario para una accion, si el despliegue la exige.
 *
 * Se consume de forma oportunista, como hace el resto del harness: un
 * despliegue sin servicio de aprobacion no concede nada, y el fallo es cerrado.
 *
 * @param ctx - contexto del plugin.
 * @param exec - contexto de ejecucion.
 * @param action - accion que necesita permiso.
 */
async function assertApproved(ctx, exec, action) {
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(`computer(${action}): esta accion exige autorizacion (config requireApprovalFor) y este despliegue no tiene servicio de aprobacion; quita "${action}" de requireApprovalFor o monta el servicio`)
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'computer',
    callId: exec.callId,
    reason: `computer use: ${action}`,
    displayReason: `Computer use quiere ejecutar "${action}" en el escritorio`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`computer(${action}): la accion no fue autorizada (${outcome}); no se ejecuto nada`)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'lib', 'computer.ps1')

/** Nombres de tecla aceptados, para que el modelo no adivine. */
const KEY_NAMES = [
  'enter', 'return', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete', 'del', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'left', 'right', 'up', 'down', 'ctrl', 'control', 'shift',
  'alt', 'win', 'windows', 'apps', 'capslock', 'numlock', 'printscreen', 'pause',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'a-z', '0-9', 'numpad0-numpad9', 'plus', 'minus', 'comma', 'period', 'slash', 'backslash',
  'semicolon', 'quote', 'lshift', 'rshift', 'lctrl', 'rctrl', 'lalt', 'ralt',
].join(', ')

/** Propiedades compartidas por las acciones que apuntan a un pixel. */
const POINT_FIELDS = {
  x: {
    type: 'integer',
    required: true,
    description: 'Coordenada X, redondeada a un entero.',
  },
  y: {
    type: 'integer',
    required: true,
    description: 'Coordenada Y, redondeada a un entero.',
  },
  space: {
    type: 'string',
    enum: ['screen', 'image'],
    description: "Marco de referencia de x/y. 'screen' = pixeles absolutos del escritorio virtual. 'image' = pixeles de la captura que acabas de ver; es el valor por defecto, porque es donde mediste.",
  },
  frame: {
    type: 'integer',
    description: 'Numero de frame devuelto por la captura, cuando la accion usa coordenadas de imagen. Por defecto, la captura mas reciente.',
  },
}

const ACTION_SPECS = {
  screenshot: {
    summary: 'Captura la pantalla y devuelve la imagen para que la veas.',
    parameters: {
      maxWidth: { type: 'integer', description: 'Ancho maximo del PNG capturado. Por defecto, la configuracion del plugin.' },
      maxHeight: { type: 'integer', description: 'Alto maximo del PNG capturado. Por defecto, la configuracion del plugin.' },
    },
    required: [],
  },
  click: { summary: 'Mueve el cursor a x,y y hace clic izquierdo.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  double_click: { summary: 'Doble clic izquierdo en x,y. Usalo para abrir iconos o archivos.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  right_click: { summary: 'Clic derecho en x,y, para menus contextuales.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  move: { summary: 'Solo mueve el cursor a x,y, sin hacer clic. Sirve para provocar hover.', parameters: POINT_FIELDS, required: ['x', 'y'] },
  drag: {
    summary: 'Arrastra con el boton izquierdo desde x,y hasta x2,y2.',
    parameters: {
      ...POINT_FIELDS,
      x2: { type: 'integer', required: true, description: 'Coordenada X del destino.' },
      y2: { type: 'integer', required: true, description: 'Coordenada Y del destino.' },
    },
    required: ['x', 'y', 'x2', 'y2'],
  },
  scroll: {
    summary: 'Rueda del raton en la posicion actual del cursor.',
    parameters: {
      amount: { type: 'integer', description: 'Positivo hacia arriba/izquierda, negativo hacia abajo/derecha. Por defecto 3.' },
      horizontal: { type: 'boolean', description: 'true para desplazamiento horizontal.' },
    },
    required: [],
  },
  type: {
    summary: 'Escribe texto en la ventana con foco, caracter por caracter. No pulsa Enter.',
    parameters: {
      text: { type: 'string', required: true, description: 'Texto literal a escribir.' },
      delayMs: { type: 'integer', description: 'Pausa entre caracteres en milisegundos. Por defecto, la configuracion del plugin.' },
    },
    required: ['text'],
  },
  key: {
    summary: 'Pulsa una sola tecla.',
    parameters: {
      key: { type: 'string', required: true, description: `Nombre de la tecla, sin distinguir mayusculas: ${KEY_NAMES}.` },
    },
    required: ['key'],
  },
  keys: {
    summary: 'Pulsa una combinacion, manteniendo todas las teclas hasta el final. Usalo para atajos.',
    parameters: {
      keys: {
        type: 'array',
        required: true,
        description: "Teclas en orden, por ejemplo ['ctrl','shift','s'] o ['alt','tab'].",
        items: { type: 'string' },
      },
    },
    required: ['keys'],
  },
  cursor: { summary: 'Donde esta el cursor ahora y que ventana tiene el foco.', parameters: {}, required: [] },
  windows: { summary: 'Enumera las ventanas con titulo, proceso, PID, rectangulo y cual tiene el foco.', parameters: {}, required: [] },
  focus_window: {
    summary: 'Trae una ventana al frente y le da el foco.',
    parameters: {
      title: { type: 'string', description: 'Fragmento del titulo, sin distinguir mayusculas. Obligatorio si no pasas handle.' },
      handle: { type: 'integer', description: 'Handle exacto devuelto por windows. Tiene prioridad sobre title.' },
    },
    required: [],
  },
  wait: {
    summary: 'Espera a que la interfaz se asiente.',
    parameters: {
      ms: { type: 'integer', description: 'Milisegundos a esperar, maximo 30000. Por defecto 500.' },
    },
    required: [],
  },
  close_window: {
    summary: 'Pide cerrar una ventana (envia WM_CLOSE, igual que el boton de cerrar). Usalo para descartar dialogos.',
    parameters: {
      title: { type: 'string', description: 'Fragmento del titulo. Obligatorio si no pasas handle.' },
      handle: { type: 'integer', description: 'Handle exacto devuelto por windows. Tiene prioridad sobre title.' },
    },
    required: [],
  },
  start_app: {
    summary: 'Abre una aplicacion de la lista permitida y devuelve su ventana, handle y PID.',
    parameters: {
      app: {
        type: 'string',
        required: true,
        enum: ['notepad', 'calculator', 'paint', 'explorer', 'cmd', 'powershell'],
        description: 'Aplicacion a abrir. Lista cerrada: no acepta rutas ni ejecutables arbitrarios.',
      },
    },
    required: ['app'],
  },
}

const ACTIONS = Object.keys(ACTION_SPECS)

/** Palabras que revelan una sola tecla frente a una combinacion. */
function isChord(keys) {
  return Array.isArray(keys) && keys.length > 1
}

/**
 * Construye la descripcion del despachador a partir de las acciones declaradas.
 * @returns descripcion orientada al modelo.
 */
function buildDescription() {
  const lines = Object.entries(ACTION_SPECS).map(([action, spec]) => `- ${action}: ${spec.summary}`)
  return [
    'Controla el escritorio de Windows: captura la pantalla, mueve el raton, hace clic, escribe y pulsa teclas.',
    'El parametro `action` elige el comportamiento; los demas parametros son los de esa accion.',
    'Flujo normal: `screenshot` (veras la imagen adjunta), mide en ella y luego `click` con space="image"; repite tras cada paso que cambie la pantalla.',
    'Empieza por `windows` o `focus_window` cuando la ventana objetivo no tenga el foco: escribir o teclear va siempre a la ventana enfocada.',
    '`click`, `type` y `key` actuan sobre lo que este en ese momento bajo el cursor o con foco; no adivines coordenadas sin una captura reciente.',
    'Acciones:',
    ...lines,
  ].join('\n')
}

/**
 * Carga la ruta del ejecutable de PowerShell.
 *
 * Prueba candidatos en orden y se queda con el primero que exista, porque la
 * instalacion varia entre equipos: Windows PowerShell 5.1 vive en System32, y
 * PowerShell 7 puede estar en Program Files, en la Microsoft Store (WindowsApps)
 * o solo en el PATH. `DSH_PWSH` manda sobre todo lo demas.
 *
 * El orden prefiere Windows PowerShell 5.1 porque, medido en un equipo real, un
 * proceso nuevo tarda 4.5-6.6 s con el frente a 9.8-18 s con el `pwsh` de la
 * Store. Para forzar otro interprete, basta `DSH_PWSH`.
 *
 * @returns ruta absoluta de un interprete, o el nombre suelto para que lo busque el sistema.
 */
function resolvePwsh() {
  if (process.env.DSH_PWSH !== undefined && process.env.DSH_PWSH.trim() !== '') return process.env.DSH_PWSH
  const candidates = [
    // Windows PowerShell 5.1: viene con Windows y es el mas rapido aqui.
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
 * Cliente del servidor persistente de PowerShell.
 *
 * Arrancar PowerShell y compilar la superficie nativa cuesta entre 8 y 22
 * segundos; una accion posterior sobre un proceso ya vivo cuesta milisegundos.
 * Este cliente mantiene un unico proceso en modo `-Server`, le escribe una
 * peticion JSON por linea y resuelve con la linea de respuesta.
 *
 * Es tolerante a fallos por diseno: si el servidor no arranca, se cae, o no
 * responde a tiempo, la llamada cae al modo de proceso unico en vez de fallar.
 */
class ComputerServer {
  /**
   * @param scriptPath - ruta absoluta del runner.
   * @param executable - interprete de PowerShell.
   * @param childTimeoutMs - limite por peticion.
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

  /** Arranca el servidor si no hay uno vivo. */
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
      if (waiting !== null) waiting.reject(new Error(`el servidor de computer use termino (${waiting.note})`))
    }
    child.on('exit', onGone)
    child.on('error', onGone)
  }

  /**
   * Entrega una linea de respuesta a quien espera.
   * @param generation - generacion del servidor que respondio.
   * @param line - linea JSON.
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
      waiting.reject(new Error(`el servidor devolvio una linea que no es JSON: ${line.slice(0, 300)}`))
      return
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.ok === false && typeof parsed.error === 'string') {
      waiting.reject(new Error(parsed.error))
      return
    }
    waiting.resolve(parsed)
  }

  /**
   * Envia una peticion y espera su respuesta.
   * @param request - objeto de peticion.
   * @param note - etiqueta para los mensajes de error.
   * @returns la respuesta del runner.
   */
  request(request, note) {
    this.ensureStarted()
    const generation = this.generation
    const child = this.child
    if (child === null || child.stdin === null) throw new Error('el servidor de computer use no tiene stdin')
    this.lastUsedAt = Date.now()
    this.armWatchdog()
    return new Promise((resolve, reject) => {
      if (this.pending !== null) {
        reject(new Error('el servidor de computer use ya tiene una peticion en curso'))
        return
      }
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`el servidor no respondio en ${this.childTimeoutMs} ms (${note})${this.stderrTail === '' ? '' : `; stderr: ${this.stderrTail.slice(-400)}`}`))
        this.stop()
      }, this.childTimeoutMs)
      this.pending = { resolve, reject, timer, note }
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error === null || error === undefined) return
        if (this.pending !== null) {
          clearTimeout(this.pending.timer)
          this.pending = null
        }
        reject(new Error(`no pude escribirle al servidor: ${error.message}`))
      })
    })
  }

  /** Cierra el servidor tras un rato sin uso, para no dejar un PowerShell vivo. */
  armWatchdog() {
    if (this.watchdog !== null) return
    this.watchdog = setInterval(() => {
      if (this.child === null) return
      if (Date.now() - this.lastUsedAt < IDLE_SHUTDOWN_MS) return
      this.stop()
    }, 60_000)
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref()
  }

  /** Detiene el servidor y deja el cliente listo para arrancar otro. */
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
      /* el flujo ya estaba cerrado */
    }
    try {
      child.kill()
    } catch {
      /* ya habia muerto */
    }
  }
}

/** Sin uso durante este tiempo, el servidor se cierra solo. */
const IDLE_SHUTDOWN_MS = 10 * 60_000

/**
 * Ejecuta el runner en un proceso nuevo: el camino de respaldo del servidor.
 *
 * Usa `spawnSync` a proposito: en este entorno `execFile` con el mismo script y
 * la misma entrada nunca liquida su callback (el hijo termina, el pipe no), y la
 * llamada se queda colgada indefinidamente. `spawnSync` devuelve siempre, con su
 * propio limite duro de tiempo.
 *
 * @param request - objeto de peticion serializado a stdin.
 * @param timeoutMs - limite para el proceso hijo.
 * @param signal - cancelacion de la llamada, comprobada antes de arrancar.
 * @returns el objeto JSON devuelto por el runner.
 */
function runNativeOneShot(request, timeoutMs, signal) {
  if (signal?.aborted === true) throw new Error('computer: la llamada se cancelo antes de arrancar el runner')
  const executable = resolvePwsh()
  // El runner lee su peticion de stdin hasta el final: hay que darsela y cerrar
  // el flujo, o se queda esperando.
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
      throw new Error(`computer: el runner no respondio en ${timeoutMs} ms (${executable}); la accion quedo sin efecto`)
    }
    throw new Error(`computer: no pude lanzar el runner (${executable}): ${outcome.error.message}`)
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

  const detail = (outcome.stderr ?? '').trim() || text || `termino con estado ${outcome.status ?? 'desconocido'}`
  throw new Error(`computer: el runner no devolvio JSON: ${detail.slice(0, 2000)}`)
}

/**
 * Limite del proceso hijo, por debajo del limite de la herramienta para que un
 * runner atascado se rinda antes que el presupuesto de la llamada.
 * @param toolTimeoutMs - limite configurado de la herramienta.
 * @returns milisegundos para el proceso hijo.
 */
function childTimeout(toolTimeoutMs) {
  return Math.max(5000, Math.min(toolTimeoutMs - 2000, 300000))
}

/**
 * Comprueba que la ruta activa declare entrada de imagen, el mismo gate que usa `read_image`.
 * @param ctx - contexto del plugin.
 * @param exec - contexto de ejecucion de la herramienta.
 * @param action - accion pedida, para el mensaje de error.
 */
async function assertImageCapableRoute(ctx, exec, action) {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) throw new Error(`computer(${action}): no pude resolver la ruta de modelo activa`)
  const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`computer(${action}) devuelve una imagen y el modelo activo ("${model}") no la acepta como entrada; elige un modelo con vision para usar computer use`)
  }
}

/**
 * Registra la herramienta `computer` en el agente.
 * @param ctx - servicios del alcance del agente.
 * @param config - configuracion resuelta del plugin.
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
    // Sin via configurada, se le pregunta al usuario en cada tarea.
    browserMode: ['perfil-propio', 'perfil-real', 'sin-navegador'].includes(config.browserMode) ? config.browserMode : null,
    browserProfileDir: typeof config.browserProfileDir === 'string' && config.browserProfileDir !== '' ? config.browserProfileDir : null,
  }

  // Un PowerShell por sesion, caliente: pagar el arranque una vez (y en segundo
  // plano) es la diferencia entre 8-22 s y milisegundos por accion.
  const server = new ComputerServer(scriptPath, resolvePwsh(), childTimeout(resolved.timeoutMs))
  // Control del navegador por CDP: la via rapida y determinista para trabajo web.
  const browser = createBrowserService(resolved)
  if (resolved.persistentShell) {
    // Arranque anticipado: mientras el modelo piensa, el servidor se calienta.
    setTimeout(() => {
      try {
        server.ensureStarted()
      } catch {
        /* el respaldo de proceso unico cubre un servidor que no arranque */
      }
    }, 0).unref?.()
  }

  ctx.on('dispose', () => {
    server.stop()
    browser.service.stop()
  })

  // Un servidor no debe sobrevivir a su anfitrion: si el proceso de DSH termina
  // sin desmontar el plugin (salida brusca, cierre de la aplicacion), el hijo se
  // cierra con el. Sin esto quedaria un PowerShell vivo esperando peticiones que
  // ya nadie va a mandar.
  const stopOnExit = () => {
    server.stop()
    browser.service.stop()
  }
  process.once('exit', stopOnExit)
  process.once('beforeExit', stopOnExit)

  /**
   * Manda una peticion al runner: primero al servidor persistente y, si ese
   * camino falla, a un proceso nuevo. Nunca deja la accion sin intentar.
   * @param request - objeto de peticion.
   * @param signal - cancelacion de la llamada.
   * @returns la respuesta del runner.
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
        throw new Error(`${error.message}; el respaldo de proceso unico tambien fallo: ${fallbackError.message}`)
      }
    }
  }

  const actionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        required: true,
        description: 'Accion a ejecutar.',
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
        description: 'Pide una captura nueva en la misma llamada, util para ver el efecto de click/type/key sin gastar otro turno.',
      },
    },
  }

  /** Mapeo imagen→pantalla de cada captura, para traducir coordenadas medidas en la imagen. */
  const frames = new Map()
  let lastFrame = 0

  const integer = (value, label) => {
    if (!Number.isInteger(value)) throw new Error(`computer: ${label} debe ser un entero; recibi ${JSON.stringify(value)}`)
    return value
  }

  /**
   * Traduce una coordenada de la accion a pixeles absolutos del escritorio virtual.
   * @param args - argumentos de la llamada.
   * @param record - frame capturado mas reciente, si lo hay.
   * @returns coordenadas absolutas.
   */
  function toScreen(args, record) {
    const x = integer(args.x, 'x')
    const y = integer(args.y, 'y')
    const space = args.space ?? (record === undefined ? 'screen' : 'image')
    if (space === 'screen') return { x, y }
    if (record === undefined) {
      throw new Error('computer: no hay ninguna captura registrada para interpretar coordenadas de imagen; llama primero a screenshot, o pasa space="screen" con pixeles absolutos')
    }
    return {
      x: Math.round(record.location.left + x * record.scale),
      y: Math.round(record.location.top + y * record.scale),
    }
  }

  /**
   * Contenido que acompanara al valor validado de cada ejecucion.
   *
   * El registro valida el valor devuelto contra `output.schema` con
   * `additionalProperties: false`, asi que un `content` dentro del valor lo
   * invalida entero (INVALID_TOOL_OUTPUT) y el modelo no recibe nada. El
   * contenido va aparte, por `finalizeContent`, que es el patron de
   * `read_image`: el valor se valida limpio y el contenido —imagen incluida— se
   * adjunta despues.
   */
  const pendingContent = new WeakMap()

  /**
   * Registra el contenido de una ejecucion y devuelve el valor validable.
   * @param exec - contexto de ejecucion que sirve de clave.
   * @param content - bloques de contenido (texto e imagen).
   * @param value - valor que se valida contra el esquema de salida.
   * @returns el valor validable.
   */
  function deliver(exec, content, value) {
    if (Array.isArray(content) && content.length > 0) pendingContent.set(exec, content)
    return value
  }

  /**
   * Construye el resultado con imagen a partir de una salida de captura.
   * @param result - salida del runner para `screenshot`.
   * @param note - linea de texto que acompana a la imagen.
   * @returns contenido de la herramienta.
   */
  async function captureContent(result, note) {
    const data = readFileSync(result.path)
    const reference = await ctx.attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: `screen-${result.frame}.png`,
    })
    frames.set(result.frame, {
      location: result.screen,
      scale: result.screen.width / reference.width,
      reference,
    })
    lastFrame = result.frame
    for (const key of frames.keys()) {
      if (key <= result.frame - 5) frames.delete(key)
    }
    const lines = [
      note,
      `captura frame ${result.frame}: ${reference.width}x${reference.height} px sobre un escritorio de ${result.screen.width}x${result.screen.height} px en (${result.screen.left}, ${result.screen.top})`,
      `orientacion: para tocar algo que veas en la imagen en (px, py), usa space="image" con x=px, y=py (frame ${result.frame}); el plugin aplica el factor ${(result.screen.width / reference.width).toFixed(4)}`,
    ].filter((line) => typeof line === 'string' && line !== '')
    return [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', attachment: reference },
    ]
  }

  /** Texto plano para acciones que no devuelven imagen. */
  function textOnly(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }

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
      return { card: 'generic', title: `Browser: ${args?.action ?? 'accion'}` }
    },
    finalizeContent(exec) {
      const content = pendingContent.get(exec)
      if (content === undefined) return undefined
      pendingContent.delete(exec)
      return content
    },
    async execute(args, exec) {
      const action = args.action
      // La captura del navegador tambien exige que el modelo vea imagenes.
      if (action === 'screenshot') await assertImageCapableRoute(ctx, exec, action)
      const outcome = await browser.execute(ctx, args)
      if (outcome.image !== undefined) {
        pendingContent.set(exec, [
          { type: 'text', text: `captura de la pestana: ${outcome.image.width}x${outcome.image.height} px` },
          { type: 'image', attachment: outcome.image },
        ])
      }
      return { action, result: { ...outcome.result, ...(outcome.text === undefined ? {} : { text: outcome.text }) } }
    },
  })

  registerComputerTool(ctx, resolved, runNative, actionSchema)
}

/**
 * Registra la herramienta `computer`: el escritorio con vision real.
 *
 * `finalizeContent` es la pieza clave. El registro valida el valor que devuelve
 * `execute` contra `output.schema` con `additionalProperties: false`, asi que un
 * `content` dentro del valor lo invalida entero y el modelo no recibe nada. El
 * contenido —imagen incluida— se adjunta despues, por aqui.
 *
 * @param ctx - contexto del plugin.
 * @param resolved - configuracion resuelta.
 * @param runNative - ejecutor del runner nativo (servidor persistente o proceso unico).
 * @param actionSchema - esquema de parametros del despachador.
 */
function registerComputerTool(ctx, resolved, runNative, actionSchema) {
  const pendingComputerContent = new WeakMap()

  /**
   * Registra el contenido de una ejecucion y devuelve el valor validable.
   * @param exec - contexto de ejecucion que sirve de clave.
   * @param content - bloques de contenido (texto e imagen).
   * @param value - valor que se valida contra el esquema de salida.
   * @returns el valor validable.
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
      return { card: 'generic', title: `Computer: ${args?.action ?? 'accion'}` }
    },
    finalizeContent(exec) {
      const content = pendingComputerContent.get(exec)
      if (content === undefined) return undefined
      pendingComputerContent.delete(exec)
      return content
    },
    async execute(args, exec) {
      const action = args.action
      if (typeof action !== 'string' || !Object.hasOwn(ACTION_SPECS, action)) throw new Error(`computer: accion desconocida ${JSON.stringify(action)}`)

      // Freno opcional: solo las acciones que el despliegue marque como sensibles.
      if (resolved.requireApprovalFor.includes(action)) await assertApproved(ctx, exec, action)

      // Las acciones que devuelven imagen pasan por el gate de vision, igual que read_image.
      if (action === 'screenshot') await assertImageCapableRoute(ctx, exec, action)

      const request = { action }
      applyArguments(action, args, request, resolved)

      const wantsShot = args.captureAfter === true
        || (args.captureAfter !== false && resolved.captureAfterActions && action !== 'wait' && action !== 'cursor' && action !== 'windows')
      if (wantsShot) {
        request.captureAfter = true
        request.maxWidth = Number.isInteger(args.maxWidth) ? args.maxWidth : resolved.maxWidth
        request.maxHeight = Number.isInteger(args.maxHeight) ? args.maxHeight : resolved.maxHeight
        await assertImageCapableRoute(ctx, exec, action)
      }

      const outcome = await runNative(request, exec.signal)
      if (wantsShot && outcome.screenshot !== undefined) {
        const content = await captureContent(outcome.screenshot, `resultado de ${action}:`)
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
 * Copia a la peticion nativa los argumentos propios de cada accion, validando lo
 * que el modelo no puede dejar mal.
 *
 * @param action - accion pedida.
 * @param args - argumentos del modelo.
 * @param request - peticion que se enviara al runner.
 * @param resolved - configuracion resuelta.
 */
function applyArguments(action, args, request, resolved) {
  if (action === 'screenshot') {
    request.maxWidth = Number.isInteger(args.maxWidth) ? args.maxWidth : resolved.maxWidth
    request.maxHeight = Number.isInteger(args.maxHeight) ? args.maxHeight : resolved.maxHeight
  }
  if (action === 'type') {
    if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('computer: type necesita text')
    request.text = args.text
    request.delayMs = Number.isInteger(args.delayMs) ? args.delayMs : resolved.typeDelayMs
  }
  if (action === 'key') {
    if (typeof args.key !== 'string' || args.key.trim() === '') throw new Error('computer: key necesita un nombre de tecla')
    request.key = args.key
  }
  if (action === 'keys') {
    const keys = Array.isArray(args.keys) ? args.keys : []
    if (keys.length === 0) throw new Error('computer: keys necesita una lista no vacia')
    if (keys.some((entry) => typeof entry !== 'string')) throw new Error('computer: keys acepta solo nombres de tecla')
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
    if (typeof args.app !== 'string' || args.app.trim() === '') throw new Error('computer: start_app necesita app')
    request.app = args.app
  }
  if (action === 'wait' && Number.isInteger(args.ms)) request.ms = args.ms
}

/**
 * Construye el esquema de parametros del despachador `browser`.
 * @returns esquema en forma de autor, con `required` por propiedad.
 */
function browserParameters() {
  const properties = {
    action: {
      type: 'string',
      enum: Object.keys(BROWSER_ACTIONS),
      required: true,
      description: 'Accion a ejecutar.',
    },
  }
  for (const spec of Object.values(BROWSER_ACTIONS)) {
    for (const [key, field] of Object.entries(spec.parameters)) {
      if (properties[key] === undefined) properties[key] = field
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
  }
}
