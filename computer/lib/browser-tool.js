/**
 * La herramienta `browser`: control del navegador por CDP.
 *
 * @module dsh-tool-computer/browser-tool
 */
import { MODIFIERS, BrowserService } from './browser.js'

/**
 * La via de navegador de la llamada.
 *
 * Es obligatoria en la practica: el plugin no la adivina ni la hereda de una
 * tarea anterior. Si falta, el ejecutor falla y pide al modelo que pregunte al
 * usuario, porque el compartimento cambia de una tarea a otra.
 */
const MODE_FIELD = {
  mode: {
    type: 'string',
    enum: ['perfil-propio', 'perfil-real', 'sin-navegador'],
    description: 'Via de navegador elegida por el usuario para ESTA tarea: "perfil-propio" (navegador aislado), "perfil-real" (su Chrome con sus sesiones) o "sin-navegador" (no tocar el navegador).',
  },
}

/** Punto y selector compartidos por las acciones que apuntan a un elemento. */
const TARGET_FIELDS = {
  ...MODE_FIELD,
  ref: {
    type: 'string',
    description: 'Referencia del ultimo snapshot (por ejemplo "e12"). Se prefiere sobre selector: es exacta y no depende de adivinar el CSS.',
  },
  selector: {
    type: 'string',
    description: 'Selector CSS, alternativa a `ref` cuando no hay snapshot o el elemento no aparece en el.',
  },
}

/** Acciones del navegador y su contrato. */
export const BROWSER_ACTIONS = {
  tabs: {
    summary: 'Lista las pestanas abiertas del navegador.',
    parameters: { ...MODE_FIELD },
    required: [],
  },
  snapshot: {
    summary: 'Lee la pagina: elementos interactivos indexados (enlaces, botones, campos), texto visible, foco y avisos. Es la forma rapida y exacta de "ver" una pagina web.',
    parameters: {
      maxElements: { type: 'integer', description: 'Cuantos elementos interactivos devolver. Por defecto, la configuracion del plugin.' },
      ...MODE_FIELD,
    },
    required: [],
  },
  click: {
    summary: 'Hace clic en un elemento, por referencia del snapshot o por selector CSS.',
    parameters: { ...TARGET_FIELDS },
    required: [],
  },
  type: {
    summary: 'Escribe texto en un elemento. Sin `ref` ni `selector`, escribe en el elemento que ya tiene el foco.',
    parameters: {
      ...TARGET_FIELDS,
      text: { type: 'string', required: true, description: 'Texto literal a escribir.' },
      clearFirst: { type: 'boolean', description: 'Vacia el campo antes de escribir. Por defecto true.' },
      pressEnter: { type: 'boolean', description: 'Pulsa Enter despues de escribir, para enviar formularios o busquedas.' },
    },
    required: ['text'],
  },
  press: {
    summary: 'Pulsa una tecla del navegador, opcionalmente con modificadores.',
    parameters: {
      key: {
        type: 'string',
        required: true,
        enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'],
        description: 'Tecla a pulsar.',
      },
      ...MODE_FIELD,
      modifiers: {
        type: 'array',
        description: 'Modificadores activos mientras se pulsa, por ejemplo ["ctrl"].',
        items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] },
      },
    },
    required: ['key'],
  },
  navigate: {
    summary: 'Navega a una direccion y devuelve el snapshot de la pagina cargada.',
    parameters: {
      url: { type: 'string', required: true, description: 'Direccion destino, absoluta.' },
      ...MODE_FIELD,
    },
    required: ['url'],
  },
  evaluate: {
    summary: 'Ejecuta JavaScript en la pagina y devuelve el resultado. Para leer datos exactos (precios, notas, tablas) que el texto visible no muestra.',
    parameters: {
      expression: { type: 'string', required: true, description: 'Expresion JavaScript cuyo valor se devuelve.' },
      ...MODE_FIELD,
    },
    required: ['expression'],
  },
  screenshot: {
    summary: 'Captura la pestana como imagen para el modelo. Usalo solo cuando la vista importe (graficos, PDF, disposicion); para leer o actuar, el snapshot es mas rapido y exacto.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capturar la pagina entera en vez de solo la vista visible.' },
      ...MODE_FIELD,
    },
    required: [],
  },
  wait: {
    summary: 'Espera a que aparezca un texto o un selector en la pagina.',
    parameters: {
      text: { type: 'string', description: 'Texto que debe aparecer. Alternativa a selector.' },
      selector: { type: 'string', description: 'Selector que debe existir. Alternativa a text.' },
      timeoutMs: { type: 'integer', description: 'Cuanto esperar como maximo. Por defecto 10000.' },
      ...MODE_FIELD,
    },
    required: [],
  },
}

/**
 * Construye la descripcion orientada al modelo.
 * @returns descripcion de la herramienta.
 */
export function browserDescription() {
  const lines = Object.entries(BROWSER_ACTIONS).map(([action, spec]) => `- ${action}: ${spec.summary}`)
  return [
    'Controla Chrome o Edge por el protocolo de depuracion: lee la estructura de la pagina y actua sobre ella sin estimar coordenadas.',
    'Para trabajo web, esta es la via preferida frente a `computer`: el snapshot devuelve los elementos con su texto y una referencia, y las acciones van por esa referencia. Es mas rapido y no falla por un pixel de diferencia.',
    'Flujo normal: `snapshot`, leer las referencias, y luego `click` o `type` con el `ref` correspondiente. Tras cada accion que cambie la pagina, toma un snapshot nuevo: las referencias viejas dejan de valer.',
    'VIA OBLIGATORIA: cada llamada lleva `mode` con la via que el usuario eligio para ESTA tarea. Si no la sabes, preguntale con ask_user_question antes de llamar, y no reutilices la de una tarea anterior.',
    'Las tres vias son: "perfil-propio" (navegador aislado, no toca sus sesiones), "perfil-real" (su Chrome de siempre, con todo lo que tenga abierto) y "sin-navegador" (no se toca el navegador; para banca o tramites personales).',
    'Usa `computer` (vision y clic real) solo cuando la tarea salga del navegador o la vista sea imprescindible.',
    'Acciones:',
    ...lines,
  ].join('\n')
}

/**
 * Crea el servicio de navegador y el ejecutor de sus acciones.
 *
 * @param config - configuracion resuelta del plugin.
 * @returns el servicio y una funcion que ejecuta una accion contra un contexto.
 */
export function createBrowserService(config) {
  const service = new BrowserService(config)

  /**
   * Ejecuta una accion del navegador.
   * @param ctx - contexto del plugin: se usa para publicar la captura.
   * @param args - argumentos de la llamada.
   * @returns el resultado, ya listo para el modelo.
   */
  async function execute(ctx, args) {
    const action = args.action
    if (typeof action !== 'string' || BROWSER_ACTIONS[action] === undefined) {
      throw new Error(`browser: accion desconocida ${JSON.stringify(action)}`)
    }

    if (action === 'tabs') {
      await service.connect(args.mode)
      const tabs = await service.connection.listTargets()
      return { action, result: { ok: true, tabs } }
    }

    if (action === 'snapshot') {
      const page = await service.snapshot(args.mode)
      return {
        action,
        result: { ok: true, ...page },
        text: formatSnapshot(page),
      }
    }

    if (action === 'click') {
      const target = await service.resolve(args.ref, args.selector, args.mode)
      await service.clickAt(target.x, target.y)
      return { action, result: { ok: true, clicked: { ref: args.ref ?? null, selector: args.selector ?? null, label: target.label, tag: target.tag } } }
    }

    if (action === 'type') {
      if (typeof args.text !== 'string') throw new Error('browser: type necesita text')
      let target
      if (args.ref !== undefined || args.selector !== undefined) {
        target = await service.resolve(args.ref, args.selector, args.mode)
        await service.clickAt(target.x, target.y)
      }
      if (args.clearFirst !== false) {
        // Selecciona todo y lo reemplaza: vale para campos vacios y con contenido.
        await service.connection.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MODIFIERS.ctrl })
        await service.connection.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MODIFIERS.ctrl })
      }
      await service.insertText(args.text)
      if (args.pressEnter === true) await service.pressKey('Enter')
      return { action, result: { ok: true, typed: args.text.length, into: target?.label ?? target?.tag ?? 'elemento con foco', pressedEnter: args.pressEnter === true } }
    }

    if (action === 'press') {
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.reduce((sum, name) => sum + (MODIFIERS[name] ?? 0), 0) : 0
      await service.connect(args.mode)
      await service.pressKey(args.key, modifiers)
      return { action, result: { ok: true, key: args.key, modifiers: args.modifiers ?? [] } }
    }

    if (action === 'navigate') {
      const page = await service.navigate(args.url, args.mode)
      return { action, result: { ok: true, ...page }, text: formatSnapshot(page) }
    }

    if (action === 'evaluate') {
      const value = await service.evaluate(args.expression, args.mode)
      return { action, result: { ok: true, value } }
    }

    if (action === 'screenshot') {
      const bytes = await service.screenshot(args.mode, args.fullPage === true)
      const reference = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: 'image/png',
        name: `browser-${Date.now()}.png`,
      })
      return { action, result: { ok: true, bytes: bytes.byteLength }, image: reference }
    }

    if (action === 'wait') {
      const timeoutMs = Number.isInteger(args.timeoutMs) ? Math.max(500, Math.min(args.timeoutMs, 120000)) : 10000
      if (args.text === undefined && args.selector === undefined) throw new Error('browser: wait necesita text o selector')
      const outcome = await service.waitFor({ text: args.text, selector: args.selector, timeoutMs }, args.mode)
      return { action, result: { ok: outcome.found, ...outcome } }
    }

    throw new Error(`browser: accion sin implementar: ${action}`)
  }

  return { service, execute }
}

/**
 * Formatea el snapshot como texto compacto, que es lo que el modelo lee.
 * @param page - estado devuelto por el snapshot.
 * @returns texto del snapshot.
 */
export function formatSnapshot(page) {
  const head = [
    `url: ${page.url}`,
    page.title === '' ? undefined : `titulo: ${page.title}`,
    `vista: ${page.viewport.width}x${page.viewport.height} px, scroll ${page.viewport.scrollY} de ${page.viewport.scrollHeight}`,
    page.focused === null ? undefined : `foco: ${page.focused}`,
    `elementos interactivos: ${page.elementCount}${page.elementCount > page.elements.length ? ` (mostrados ${page.elements.length})` : ''}`,
  ].filter((line) => line !== undefined)

  const rows = page.elements.map((element) => {
    const parts = [`[${element.ref}]`, `<${element.tag}${element.type === undefined ? '' : ` type=${element.type}`}>`]
    if (element.label !== '') parts.push(`"${element.label}"`)
    if (element.value !== undefined) parts.push(`valor="${element.value}"`)
    if (element.checked !== undefined) parts.push(element.checked ? 'marcado' : 'sin marcar')
    if (element.disabled === true) parts.push('DESHABILITADO')
    if (element.offscreen === true) parts.push('fuera de la vista')
    if (element.selector !== undefined) parts.push(`selector=${element.selector}`)
    return parts.join(' ')
  })

  const text = page.text === '' ? '' : `\n--- texto visible${page.truncated ? ' (recortado)' : ''} ---\n${page.text}`
  return `${head.join('\n')}\n\n${rows.join('\n')}${text}`
}
