/**
 * Schema guard: checks the JSON Schemas this plugin publishes to the model.
 *
 * A schema the provider rejects does not fail one action: it fails EVERY turn,
 * with a message like `Invalid schema for function 'browser': true is not of type
 * "array"`. That happened once, from a constrained `items` schema, so the shape
 * of what goes on the wire is now asserted instead of assumed.
 *
 * What it checks, in the plugin's own generated schemas and in the raw author
 * specs:
 *   1. Every `array` declares `items`, and `items` is an object (never a boolean,
 *      never an array, never absent).
 *   2. Every `array`'s `items` declares a `type` or a `oneOf`.
 *   3. No `items` carries a nested `enum` or `const`: constrained item schemas are
 *      what strict provider validators choke on.
 *   4. Every `object` declares `additionalProperties` as a boolean.
 *   5. `required`, where present, is an array of strings.
 *   6. No `type` is an array (union types are not accepted by the providers).
 *
 * Usage: node scripts/schema-guard.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'computer', 'index.js')).href)

const registered = []
plugin.apply({
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  attachments: { saveImage: async () => ({}) },
  get: () => undefined,
  on: () => {},
}, {})

if (registered.length === 0) {
  console.error('FAIL: the plugin registered no tools')
  process.exit(1)
}

const problems = []

/**
 * Walks one schema node, collecting violations.
 * @param node - schema value.
 * @param path - dotted path for messages.
 */
function check(node, path) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((entry, index) => check(entry, `${path}[${index}]`))
    return
  }

  if (Array.isArray(node.type)) problems.push(`${path}.type is an array (union types are rejected): ${JSON.stringify(node.type)}`)

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
      if (Object.hasOwn(node.items, 'enum') || Object.hasOwn(node.items, 'const')) {
        problems.push(`${path}.items carries a nested enum/const, which strict provider validators reject: ${JSON.stringify(node.items)}`)
      }
    }
  }

  if (node.type === 'object' && !Object.hasOwn(node, 'additionalProperties')) {
    problems.push(`${path} is an object without \`additionalProperties\``)
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    problems.push(`${path}.additionalProperties must be a boolean, got ${JSON.stringify(node.additionalProperties)}`)
  }

  for (const [key, value] of Object.entries(node)) check(value, `${path}.${key}`)
}

for (const tool of registered) {
  const before = problems.length
  check(tool.parameters, `${tool.name}.parameters`)
  check(tool.output?.schema, `${tool.name}.output.schema`)
  const arrays = JSON.stringify(tool.parameters).match(/"type":"array"/g)?.length ?? 0
  const state = problems.length === before ? 'ok' : `${problems.length - before} problem(s)`
  console.log(`  ${tool.name}: ${state} (${arrays} array schema(s), ${Object.keys(tool.parameters.properties ?? {}).length} parameters)`)
}

if (problems.length > 0) {
  console.error('\nFAIL: the published schemas have problems that can break every turn:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('\nSchema guard passed: what goes on the wire is safe for a strict validator.')
