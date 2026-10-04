/**
 * Prueba de integracion de la herramienta `browser` contra Chrome de verdad.
 *
 * Lanza el navegador con perfil temporal, navega, lee el snapshot, hace clic por
 * referencia, comprueba que cambio de pagina y captura una imagen. Ademas imita
 * lo que hace el registro de herramientas: ejecuta `finalizeContent` y comprueba
 * que los bloques de contenido —imagen incluida— son los que espera el modelo.
 *
 * Uso: node scripts/browser-integration.mjs   (desde la raiz del repositorio)
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'computer', 'index.js')).href)

const registered = []
const disposers = []
const ctx = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  attachments: {
    saveImage: async (input) => ({
      attachmentId: `attachment-${input.name}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 800,
      height: 600,
      name: input.name,
    }),
  },
  get: () => undefined,
  on: (event, handler) => {
    if (event === 'dispose') disposers.push(handler)
  },
}

// Puerto propio para no chocar con una instancia previa de las pruebas.
// Via "perfil-propio": navegador aislado con perfil temporal, sin tocar el del usuario.
plugin.apply(ctx, { maxElements: 30, browserPorts: [9333], browserMode: 'perfil-propio' })
const tool = registered.find((entry) => entry.name === 'browser')
if (tool === undefined) throw new Error('la herramienta browser no se registro')
const computerTool = registered.find((entry) => entry.name === 'computer')

const exec = {
  agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } },
  signal: new AbortController().signal,
  callId: 'integration',
}

/**
 * Ejecuta una accion imitando el registro: valor + finalizeContent.
 * @param args - argumentos de la accion.
 * @returns el valor y los bloques de contenido que veria el modelo.
 */
async function run(args) {
  const started = Date.now()
  try {
    const value = await tool.execute(args, exec)
    const content = tool.finalizeContent(exec)
    const kinds = Array.isArray(content) ? content.map((b) => b.type).join('+') : 'text'
    console.log(`[${Date.now() - started} ms] ${args.action}: ok=${value.result.ok} content=${kinds}`)
    return { value, content }
  } catch (error) {
    console.log(`[${Date.now() - started} ms] ${args.action}: FALLO ${error.message.slice(0, 220)}`)
    return undefined
  }
}

/**
 * Ejecuta la bateria y garantiza la limpieza: si una prueba falla a mitad, el
 * navegador lanzado se cierra igual. Sin esto quedan procesos huerfanos, que es
 * exactamente lo que paso en la primera version de esta prueba.
 */
async function main() {
  console.log('--- 1. navegar ---')
  const navigated = await run({ action: 'navigate', url: 'https://example.com' })
  if (navigated !== undefined) {
    console.log('   url:', navigated.value.result.url, '| titulo:', navigated.value.result.title)
    for (const element of navigated.value.result.elements.slice(0, 4)) {
      console.log(`     [${element.ref}] <${element.tag}> "${element.label}"`)
    }
  }

  console.log('\n--- 2. snapshot (la via rapida frente a la vision) ---')
  const snapshotted = await run({ action: 'snapshot' })
  if (snapshotted !== undefined) {
    console.log(snapshotted.value.result.text.split('\n').slice(0, 7).map((line) => `   ${line}`).join('\n'))
  }

  console.log('\n--- 3. clic por referencia (determinista) ---')
  const clicked = await run({ action: 'click', ref: 'e1' })
  if (clicked !== undefined) console.log('   clic en:', clicked.value.result.clicked.label)

  console.log('\n--- 4. la pagina cambio ---')
  const after = await run({ action: 'snapshot' })
  if (after !== undefined) console.log('   url:', after.value.result.url, '| titulo:', after.value.result.title)

  console.log('\n--- 5. datos exactos por JavaScript ---')
  const evaluated = await run({ action: 'evaluate', expression: '({ links: document.links.length, href: location.href })' })
  if (evaluated !== undefined) console.log('   valor:', JSON.stringify(evaluated.value.result.value))

  console.log('\n--- 6. escribir en un campo de un formulario real ---')
  await run({ action: 'navigate', url: 'https://www.google.com' })
  const typed = await run({ action: 'type', selector: 'textarea[name=q], input[name=q]', text: 'prueba de computer use', pressEnter: false })
  if (typed !== undefined) console.log('   escrito en:', typed.value.result.into)
  const value = await run({ action: 'evaluate', expression: '(document.querySelector("textarea[name=q], input[name=q]") || {}).value' })
  if (value !== undefined) console.log('   el campo contiene:', JSON.stringify(value.value.result.value))

  console.log('\n--- 7. captura del navegador con imagen adjunta ---')
  const shot = await run({ action: 'screenshot' })
  if (shot !== undefined) {
    console.log('   bytes:', shot.value.result.bytes)
    const imageBlock = shot.content?.find((block) => block.type === 'image')
    console.log('   bloque de imagen:', imageBlock === undefined ? 'AUSENTE' : `${imageBlock.attachment.mediaType} ${imageBlock.attachment.width}x${imageBlock.attachment.height}`)
  }

  console.log('\n--- 8. la herramienta computer sigue registrada ---')
  console.log('   computer:', computerTool === undefined ? 'AUSENTE' : `${computerTool.parameters.properties.action.enum.length} acciones`)
}

try {
  await main()
} finally {
  // Guaranteed teardown: the plugin's disposers close the browser and its
  // temporary profile. Without this, orphan processes survive — which is exactly
  // what the first version of this test shipped.
  for (const disposer of disposers) disposer()
  console.log('\ncleanup: disposers ran; waiting for the browser to release everything')
  // Chrome's helper processes and the profile are released a few seconds after
  // the tree is killed, so this polls instead of sampling once: measuring too
  // early produced false alarms about leftovers that were only slow exits.
  const deadline = Date.now() + 30000
  let leftover = -1
  while (Date.now() < deadline) {
    leftover = countChromeWithTempProfile()
    if (leftover === 0) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const profiles = countTempProfiles()
  const clean = leftover === 0 && profiles === 0
  console.log(clean
    ? 'cleanup verified: 0 browser processes and 0 temporary profiles'
    : `WARNING: ${leftover} browser processes and ${profiles} temporary profiles left behind`)
  process.exit(clean ? 0 : 1)
}

/**
 * Counts temporary Chrome profiles left in the temp directory.
 * @returns how many remain.
 */
function countTempProfiles() {
  const result = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    '@(Get-ChildItem $env:TEMP -Directory -Filter "dsh-cdp-*" -ErrorAction SilentlyContinue).Count',
  ], { encoding: 'utf8', timeout: 30000 })
  const count = Number.parseInt((result.stdout ?? '').trim(), 10)
  return Number.isFinite(count) ? count : -1
}

/**
 * Cuenta los procesos de Chrome que siguen usando un perfil temporal de prueba.
 *
 * Excluye el propio proceso de PowerShell del conteo: su linea de comandos
 * contiene el texto buscado y se contaba a si mismo, que es como esta
 * comprobacion dio un falso positivo la primera vez.
 *
 * @returns cuantos quedan, o -1 si no se pudo medir.
 */
function countChromeWithTempProfile() {
  const script = [
    '$me = $PID;',
    '@(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" |',
    'Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like \'*dsh-cdp-*\' }).Count',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 })
  const count = Number.parseInt((result.stdout ?? '').trim(), 10)
  return Number.isFinite(count) ? count : -1
}
