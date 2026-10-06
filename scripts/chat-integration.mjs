/**
 * Prueba de la conversacion con un chat web: `send` y `settle`.
 *
 * Arranca el servidor de prueba, navega, escribe en el compositor editable, envia,
 * y comprueba que `settle` espera a que el streaming TERMINE: el texto que se
 * devuelve debe ser el completo, no un trozo.
 *
 * Uso: node scripts/chat-integration.mjs
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = 8734

const server = spawn(process.execPath, [join(here, 'chat-fixture.mjs'), String(port)], { stdio: 'ignore', windowsHide: true })
const plugin = await import(pathToFileURL(join(here, '..', 'computer', 'index.js')).href)

const registered = []
const disposers = []
plugin.apply({
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  llm: { resolveModelInfo: async (provider, model) => ({ provider, model, inputModalities: ['text', 'image'] }) },
  attachments: {
    saveImage: async (input) => ({ attachmentId: 'fixture', mediaType: input.mediaType, bytes: input.data.byteLength, width: 800, height: 600 }),
  },
  get: () => undefined,
  on: (event, handler) => { if (event === 'dispose') disposers.push(handler) },
}, { maxElements: 40, browserPorts: [9335], browserMode: 'own-profile' })

const browser = registered.find((entry) => entry.name === 'browser')
const exec = { agent: { options: {}, session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) } }, signal: new AbortController().signal, callId: 'chat' }

/** Ejecuta una accion y muestra su resultado resumido. */
async function run(args) {
  const started = Date.now()
  try {
    const value = await browser.execute({ mode: 'own-profile', ...args }, exec)
    browser.finalizeContent(exec)
    console.log(`[${Date.now() - started} ms] ${args.action}: ok=${value.result.ok}`)
    return value.result
  } catch (error) {
    console.log(`[${Date.now() - started} ms] ${args.action}: FALLO ${error.message.slice(0, 200)}`)
    return undefined
  }
}

try {
  // Espera a que el servidor de prueba escuche.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/`)
      if (probe.ok) break
    } catch {
      /* todavia no levanta */
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  console.log('--- 1. navegar a la pagina de prueba ---')
  const page = await run({ action: 'navigate', url: `http://127.0.0.1:${port}/` })

  console.log('\n--- 2. el compositor editable aparece como interactivo? ---')
  const snapshot = await run({ action: 'snapshot' })
  const composer = snapshot?.elements?.find((element) => element.editable === true)
  console.log('   elementos: ' + (snapshot?.elements?.length ?? 0))
  console.log('   composer editable: ' + (composer ? `[${composer.ref}] <${composer.tag}> editable=${composer.editable}` : 'NO ENCONTRADO'))
  if (composer === undefined) throw new Error('el compositor contenteditable no aparece en el snapshot')

  console.log('\n--- 3. send: escribe y envia con Enter ---')
  const sent = await run({ action: 'send', ref: composer.ref, text: 'Hola, respondeme algo largo por favor' })
  console.log('   enviado: ' + JSON.stringify(sent?.sent) + ' caracteres en ' + JSON.stringify(sent?.into))

  console.log('\n--- 4. settle: espera a que el streaming termine ---')
  const settled = await run({ action: 'settle', selector: '#answer', quietMs: 1000, timeoutMs: 60000 })
  console.log('   settled=' + settled?.settled + '  espero=' + settled?.waitedMs + ' ms  caracteres=' + settled?.chars)

  console.log('\n--- 5. el texto recibido es el COMPLETO? ---')
  const read = await run({ action: 'evaluate', expression: 'document.querySelector("#answer").innerText.trim()' })
  const text = read?.value ?? ''
  const expected = 'Esta respuesta llega token a token y solo debe leerse cuando termine de escribirse por completo.'
  console.log('   texto: ' + JSON.stringify(text.slice(0, 120)))
  console.log('   completo: ' + (text === expected ? 'SI' : `NO (esperado ${expected.length} caracteres, hay ${text.length})`))
  console.log('   longitud: ' + text.length + ' de ' + expected.length)
} finally {
  for (const disposer of disposers) disposer()
  server.kill()
  await new Promise((resolve) => setTimeout(resolve, 3000))
  console.log('\nlimpieza: servidor de prueba cerrado')
  process.exit(0)
}
