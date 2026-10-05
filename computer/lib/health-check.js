/**
 * Health check: decides whether this plugin may load, and says so without
 * depending on the plugin working.
 *
 * This exists because of a real outage. The plugin published tool schemas the
 * provider rejects, so EVERY turn failed — including the turns that would have
 * let the agent fix or disable it. Nothing checked the plugin's own contract
 * before it broke the session, so the guard now runs first, in the same loader
 * row, and a failure degrades to "the row does not load" instead of "the session
 * is dead".
 *
 * Run it by hand any time:
 *   node <profile>/plugins/computer/lib/health-check.js
 *
 * It exits 0 when the plugin is safe to load and 1 when it must not load.
 *
 * It is deliberately dependency-free and side-effect-free: no network, no files
 * written, nothing started. It only builds the schemas and inspects them.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Raw shapes the provider-side validator refuses. Checked, not assumed. */
const FORBIDDEN_IN_ITEMS = ['enum', 'const', 'required']

/**
 * Validates one generated schema tree.
 * @param node - schema value.
 * @param path - dotted path for messages.
 * @param problems - collector.
 */
function inspect(node, path, problems) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((entry, index) => inspect(entry, `${path}[${index}]`, problems))
    return
  }

  if (Array.isArray(node.type)) {
    problems.push(`${path}.type is an array; providers reject union types: ${JSON.stringify(node.type)}`)
  }

  if (Object.hasOwn(node, 'required') && (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string'))) {
    problems.push(`${path}.required must be an array of strings, got ${JSON.stringify(node.required)}`)
  }

  if (node.type === 'array') {
    if (!Object.hasOwn(node, 'items')) {
      problems.push(`${path} is an array with no \`items\``)
    } else if (node.items === null || typeof node.items !== 'object' || Array.isArray(node.items)) {
      problems.push(`${path}.items must be an object, got ${JSON.stringify(node.items)}`)
    } else {
      if (!Object.hasOwn(node.items, 'type') && !Object.hasOwn(node.items, 'oneOf')) {
        problems.push(`${path}.items declares neither \`type\` nor \`oneOf\`: ${JSON.stringify(node.items)}`)
      }
      for (const key of FORBIDDEN_IN_ITEMS) {
        if (Object.hasOwn(node.items, key)) {
          problems.push(`${path}.items carries \`${key}\`, which strict provider validators reject`)
        }
      }
    }
  }

  if (node.type === 'object' && !Object.hasOwn(node, 'additionalProperties')) {
    problems.push(`${path} is an object without \`additionalProperties\``)
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    problems.push(`${path}.additionalProperties must be a boolean, got ${JSON.stringify(node.additionalProperties)}`)
  }

  // A boolean anywhere a schema node is expected is the exact class of bug that
  // caused the outage: DSH's author form uses `required: true` per property, and
  // sending it uncompiled put a boolean where an array of names belongs. Note that
  // `additionalProperties` is legitimately a boolean, so it is not in this list.
  for (const key of ['items', 'properties']) {
    const value = node[key]
    if (value !== undefined && value !== null && typeof value === 'object') continue
    if (value === undefined) continue
    problems.push(`${path}.${key} must be a schema object, got ${JSON.stringify(value)}`)
  }

  for (const [key, value] of Object.entries(node)) inspect(value, `${path}.${key}`, problems)
}

/**
 * Builds the plugin's schemas and checks what would go on the wire.
 * @returns the list of problems; empty means safe to load.
 */
export async function runHealthCheck() {
  const here = dirname(fileURLToPath(import.meta.url))
  const pluginEntry = join(here, '..', 'index.js')
  const problems = []

  let plugin
  try {
    plugin = await import(pathToFileURL(pluginEntry).href)
  } catch (error) {
    return [`the plugin entry did not import: ${error.message}`]
  }

  for (const exported of ['name', 'Config', 'apply', 'inject']) {
    if (plugin[exported] === undefined) problems.push(`the plugin does not export \`${exported}\``)
  }
  if (typeof plugin.apply !== 'function') return problems.length > 0 ? problems : ['the plugin exports no apply function']

  const registered = []
  try {
    plugin.apply({
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
      attachments: { saveImage: async () => ({}) },
      get: () => undefined,
      on: () => {},
    }, {})
  } catch (error) {
    problems.push(`applying the plugin threw: ${error.message}`)
    return problems
  }

  if (registered.length === 0) problems.push('the plugin registered no tools')

  for (const tool of registered) {
    if (typeof tool.name !== 'string' || tool.name === '') problems.push('a registered tool has no name')
    if (typeof tool.description !== 'string' || tool.description === '') problems.push(`tool ${tool.name} has no description`)
    if (tool.parameters === undefined) problems.push(`tool ${tool.name} declares no parameters`)
    else inspect(tool.parameters, `${tool.name}.parameters`, problems)
    if (tool.output?.schema === undefined) problems.push(`tool ${tool.name} declares no output schema`)
    else inspect(tool.output.schema, `${tool.name}.output.schema`, problems)
    if (typeof tool.execute !== 'function') problems.push(`tool ${tool.name} has no execute function`)
  }

  return problems
}

// Only run as a program, so importing this module stays free of side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await runHealthCheck()
  if (problems.length === 0) {
    console.log('dsh-tool-computer: health check passed, safe to load')
    process.exit(0)
  }
  console.error('dsh-tool-computer: health check FAILED, this plugin must not load:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  console.error('To keep working, disable this plugin in the profile patch:')
  console.error('  set `disabled: true` on the tool-computer row of cordis.patch.yml, then restart DSH.')
  process.exit(1)
}
