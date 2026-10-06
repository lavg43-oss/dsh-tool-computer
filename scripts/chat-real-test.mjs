/**
 * Real test against a web chat, through the plugin's own browser tool.
 *
 * It opens a chat URL, reports whether the page offers a composer and, when it
 * does, sends a message and waits for the streamed answer to finish. Nothing is
 * simulated: this is the same code path the `browser` tool uses.
 *
 * Verified against Gemini, with no account: the composer is a `contenteditable`
 * div, `send` wrote the message and pressed Enter, `settle` returned when the
 * answer stopped growing, and the answer came back whole. `chat-integration.mjs`
 * is the offline version of the same check, against a local page that streams.
 *
 * Usage: node scripts/chat-real-test.mjs [url] [port]
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'computer', 'index.js')).href)

const target = process.argv[2] ?? 'https://gemini.google.com/app?hl=es-MX'
const port = Number(process.argv[3] ?? 9337)
const prompt = 'Responde solo con: PRUEBA DE COMPUTER USE OK'

const registered = []
const disposers = []
plugin.apply({
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  llm: { resolveModelInfo: async (provider, model) => ({ provider, model, inputModalities: ['text', 'image'] }) },
  attachments: { saveImage: async (input) => ({ attachmentId: 't', mediaType: input.mediaType, bytes: input.data.byteLength, width: 800, height: 600 }) },
  get: () => undefined,
  on: (event, handler) => { if (event === 'dispose') disposers.push(handler) },
}, { maxElements: 60, browserPorts: [port], browserMode: 'own-profile' })

const browser = registered.find((entry) => entry.name === 'browser')
const exec = {
  agent: { options: {}, session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) } },
  signal: new AbortController().signal,
  callId: 'chat-real-test',
}

/** Runs one browser action and summarises it. */
async function run(args, label) {
  const started = Date.now()
  try {
    const value = await browser.execute({ mode: 'own-profile', ...args }, exec)
    browser.finalizeContent(exec)
    console.log(`[${Date.now() - started} ms] ${label ?? args.action}: ok=${value.result.ok}`)
    return value.result
  } catch (error) {
    console.log(`[${Date.now() - started} ms] ${label ?? args.action}: FAILED ${error.message.slice(0, 220)}`)
    return undefined
  }
}

try {
  console.log('=== 1. open the chat (isolated profile) ===')
  console.log('    target: ' + target)
  const page = await run({ action: 'navigate', url: target }, 'navigate')
  console.log('    url:    ' + (page?.url ?? '?'))
  console.log('    title:  ' + JSON.stringify(page?.title ?? ''))

  // Give the app time to mount its interface.
  await new Promise((resolve) => setTimeout(resolve, 3000))

  console.log('\n=== 2. does the page offer a composer? ===')
  const state = await run({
    action: 'evaluate',
    expression: `({
      url: location.href,
      hasComposer: document.querySelector('[contenteditable="true"], textarea, [role="textbox"]') !== null,
      bodyStart: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 240),
    })`,
  }, 'evaluate')
  console.log('    url:          ' + state?.value?.url)
  console.log('    hasComposer:  ' + state?.value?.hasComposer)
  console.log('    visible text: ' + JSON.stringify((state?.value?.bodyStart ?? '').slice(0, 180)))

  console.log('\n=== 3. snapshot ===')
  const snapshot = await run({ action: 'snapshot' }, 'snapshot')
  console.log('    interactive elements: ' + (snapshot?.elementCount ?? 0))
  for (const element of (snapshot?.elements ?? []).slice(0, 10)) {
    const flags = element.editable === true ? 'EDITABLE' : ''
    console.log(`      [${element.ref}] <${element.tag}> "${(element.label ?? '').slice(0, 36)}" ${flags}`)
  }
  const composer = (snapshot?.elements ?? []).find((element) => element.editable === true)
  console.log('    editable composer: ' + (composer ? `[${composer.ref}]` : 'NOT FOUND'))

  if (composer === undefined) {
    console.log('\n=== 4. no composer: this page needs a session first ===')
    console.log("    The plugin never types a password or solves a captcha: that step is the user's.")
  } else {
    console.log('\n=== 4. send a message and wait for the answer ===')
    const sent = await run({ action: 'send', ref: composer.ref, text: prompt }, 'send')
    console.log('    sent: ' + JSON.stringify(sent?.sent) + ' chars')
    const settled = await run({ action: 'settle', quietMs: 1500, timeoutMs: 90000 }, 'settle')
    console.log('    settled=' + settled?.settled + ' waited=' + settled?.waitedMs + ' ms chars=' + settled?.chars)
    const read = await run({
      action: 'evaluate',
      expression: 'document.body.innerText.replace(/\\s+/g, " ").slice(-700)',
    }, 'read the answer')
    console.log('    end of the conversation:')
    console.log('      ' + JSON.stringify((read?.value ?? '').slice(-450)))
  }
} finally {
  for (const disposer of disposers) disposer()
  await new Promise((resolve) => setTimeout(resolve, 4000))
  console.log('\ncleanup: test browser closed')
  process.exit(0)
}
