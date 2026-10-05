/**
 * The `browser` tool: browser control over CDP.
 *
 * @module dsh-tool-computer/browser-tool
 */
import { MODIFIERS, BrowserService } from './browser.js'

/**
 * The browser mode for this call.
 *
 * It is required in practice: the plugin neither guesses it nor inherits it from
 * an earlier task. When it is missing, the executor fails and tells the model to
 * ask the user, because the compartment changes from one task to the next.
 */
const MODE_FIELD = {
  mode: {
    type: 'string',
    enum: ['own-profile', 'real-profile', 'no-browser'],
    description: 'Browser mode the user chose for THIS task: "own-profile" (isolated browser), "real-profile" (their Chrome with their sessions) or "no-browser" (do not touch the browser). The Spanish aliases perfil-propio, perfil-real and sin-navegador are accepted too.',
  },
}

/** Point and selector shared by the actions that target an element. */
const TARGET_FIELDS = {
  ...MODE_FIELD,
  ref: {
    type: 'string',
    description: 'Reference from the last snapshot (for example "e12"). Preferred over selector: it is exact and does not depend on guessing CSS.',
  },
  selector: {
    type: 'string',
    description: 'CSS selector, an alternative to `ref` when there is no snapshot or the element is not in it.',
  },
}

/** Browser actions and their contract. */
export const BROWSER_ACTIONS = {
  tabs: {
    summary: 'Lists the browser tabs that are open.',
    parameters: { ...MODE_FIELD },
    required: [],
  },
  snapshot: {
    summary: 'Reads the page: indexed interactive elements (links, buttons, fields), visible text, focus and notices. This is the fast, exact way to "see" a web page.',
    parameters: {
      maxElements: { type: 'integer', description: 'How many interactive elements to return. Defaults to the plugin configuration.' },
      ...MODE_FIELD,
    },
    required: [],
  },
  click: {
    summary: 'Clicks an element, by snapshot reference or by CSS selector.',
    parameters: { ...TARGET_FIELDS },
    required: [],
  },
  type: {
    summary: 'Types text into an element. Without `ref` or `selector`, types into whatever already has focus.',
    parameters: {
      ...TARGET_FIELDS,
      text: { type: 'string', required: true, description: 'Literal text to type.' },
      clearFirst: { type: 'boolean', description: 'Clears the field before typing. Defaults to true.' },
      pressEnter: { type: 'boolean', description: 'Presses Enter after typing, to submit forms or run searches.' },
    },
    required: ['text'],
  },
  press: {
    summary: 'Presses a browser key, optionally with modifiers.',
    parameters: {
      key: {
        type: 'string',
        required: true,
        enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'],
        description: 'Key to press.',
      },
      ...MODE_FIELD,
      modifiers: {
        type: 'array',
        description: 'Modifiers held while pressing: any of "alt", "ctrl", "meta", "shift", for example ["ctrl"].',
        // Deliberately no nested `enum` here. A constrained `items` schema is a
        // construct some strict provider-side validators reject, and a rejected
        // schema makes every turn fail, not just this action. The allowed values
        // are in the description instead: the model reads that, and nothing on the
        // wire can break.
        items: { type: 'string' },
      },
    },
    required: ['key'],
  },
  navigate: {
    summary: 'Navigates to a URL and returns the snapshot of the loaded page.',
    parameters: {
      url: { type: 'string', required: true, description: 'Destination URL, absolute.' },
      ...MODE_FIELD,
    },
    required: ['url'],
  },
  evaluate: {
    summary: 'Runs JavaScript in the page and returns the result. For exact data (prices, grades, tables) that the visible text does not show.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression whose value is returned.' },
      ...MODE_FIELD,
    },
    required: ['expression'],
  },
  screenshot: {
    summary: 'Captures the tab as an image for the model. Use it only when the visual matters (charts, PDFs, layout); for reading or acting, the snapshot is faster and exact.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Captures the whole page instead of only the visible viewport.' },
      ...MODE_FIELD,
    },
    required: [],
  },
  wait: {
    summary: 'Waits for a text or a selector to appear in the page.',
    parameters: {
      text: { type: 'string', description: 'Text that must appear. Alternative to selector.' },
      selector: { type: 'string', description: 'Selector that must exist. Alternative to text.' },
      timeoutMs: { type: 'integer', description: 'How long to wait at most. Defaults to 10000.' },
      ...MODE_FIELD,
    },
    required: [],
  },
}

/**
 * Builds the model-facing description.
 * @returns the tool description.
 */
export function browserDescription() {
  const lines = Object.entries(BROWSER_ACTIONS).map(([action, spec]) => `- ${action}: ${spec.summary}`)
  return [
    'Drives Chrome or Edge over the DevTools Protocol: reads the page structure and acts on it without estimating coordinates.',
    'For web work this is the preferred path over `computer`: the snapshot returns elements with their text and a reference, and actions go by that reference. It is faster and does not miss by a pixel.',
    'Normal flow: `snapshot`, read the references, then `click` or `type` with the matching `ref`. After any action that changes the page, take a new snapshot: old references stop resolving.',
    'MODE IS MANDATORY: every call carries `mode` with the mode the user chose for THIS task. If you do not know it, ask with ask_user_question before calling, and do not reuse the one from an earlier task.',
    'The three modes are: "own-profile" (isolated browser, touches none of their sessions), "real-profile" (their everyday Chrome, with everything they have open) and "no-browser" (the browser is not touched at all; for banking or personal paperwork).',
    'Use `computer` (vision and real clicking) only when the task leaves the browser or the visual is essential.',
    'Actions:',
    ...lines,
  ].join('\n')
}

/**
 * Creates the browser service and the executor for its actions.
 *
 * @param config - resolved plugin configuration.
 * @returns the service and a function that runs one action against a context.
 */
export function createBrowserService(config) {
  const service = new BrowserService(config)

  /**
   * Runs one browser action.
   * @param ctx - plugin context, used to publish the capture.
   * @param args - call arguments.
   * @returns the result, ready for the model.
   */
  async function execute(ctx, args) {
    const action = args.action
    if (typeof action !== 'string' || BROWSER_ACTIONS[action] === undefined) {
      throw new Error(`browser: unknown action ${JSON.stringify(action)}`)
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
      if (typeof args.text !== 'string') throw new Error('browser: type needs text')
      let target
      if (args.ref !== undefined || args.selector !== undefined) {
        target = await service.resolve(args.ref, args.selector, args.mode)
        await service.clickAt(target.x, target.y)
      }
      if (args.clearFirst !== false) {
        // Select all and replace: works for empty fields and for filled ones.
        await service.connection.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MODIFIERS.ctrl })
        await service.connection.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MODIFIERS.ctrl })
      }
      await service.insertText(args.text)
      if (args.pressEnter === true) await service.pressKey('Enter')
      return { action, result: { ok: true, typed: args.text.length, into: target?.label ?? target?.tag ?? 'focused element', pressedEnter: args.pressEnter === true } }
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
      if (args.text === undefined && args.selector === undefined) throw new Error('browser: wait needs text or selector')
      const outcome = await service.waitFor({ text: args.text, selector: args.selector, timeoutMs }, args.mode)
      return { action, result: { ok: outcome.found, ...outcome } }
    }

    throw new Error(`browser: action not implemented: ${action}`)
  }

  return { service, execute }
}

/**
 * Formats the snapshot as compact text, which is what the model reads.
 * @param page - state returned by the snapshot.
 * @returns the snapshot text.
 */
export function formatSnapshot(page) {
  const head = [
    `url: ${page.url}`,
    page.title === '' ? undefined : `title: ${page.title}`,
    `viewport: ${page.viewport.width}x${page.viewport.height} px, scroll ${page.viewport.scrollY} of ${page.viewport.scrollHeight}`,
    page.focused === null ? undefined : `focus: ${page.focused}`,
    `interactive elements: ${page.elementCount}${page.elementCount > page.elements.length ? ` (showing ${page.elements.length})` : ''}`,
  ].filter((line) => line !== undefined)

  const rows = page.elements.map((element) => {
    const parts = [`[${element.ref}]`, `<${element.tag}${element.type === undefined ? '' : ` type=${element.type}`}>`]
    if (element.label !== '') parts.push(`"${element.label}"`)
    if (element.value !== undefined) parts.push(`value="${element.value}"`)
    if (element.checked !== undefined) parts.push(element.checked ? 'checked' : 'unchecked')
    if (element.disabled === true) parts.push('DISABLED')
    if (element.offscreen === true) parts.push('offscreen')
    if (element.selector !== undefined) parts.push(`selector=${element.selector}`)
    return parts.join(' ')
  })

  const text = page.text === '' ? '' : `\n--- visible text${page.truncated ? ' (truncated)' : ''} ---\n${page.text}`
  return `${head.join('\n')}\n\n${rows.join('\n')}${text}`
}
