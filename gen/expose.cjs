// Copies the SDK bundle and exports every top-level zod schema, so a
// generator can walk them. A bundle split into chunks (0.11 on) imports the
// others; each is copied next to out, keeping its own exports, and adds
// its schemas to the ones out exports.
const fs = require('fs')
const path = require('path')
const [src, out] = process.argv.slice(2)

function declared(text) {
  const names = new Set()
  for (const m of text.matchAll(/^var (\w+Schema\w*) = /gm)) names.add(m[1])
  // Also enums used as nativeEnum / value lists.
  const enums = new Set()
  for (const m of text.matchAll(/^var (\w+) = \/\* @__PURE__ \*\/ \(\((\w+)\) => \{/gm))
    enums.add(m[1])
  return { names, enums }
}

const list = (names) => [...names].map((n) => `  ${n}`).join(',\n')

let text = fs.readFileSync(src, 'utf8')
const deps = [...new Set([...text.matchAll(/from "\.\/(chunk-\w+\.mjs)"/g)].map((m) => m[1]))]
const imports = []
const spreadSchemas = []
const spreadEnums = []
deps.forEach((dep, i) => {
  const depText = fs.readFileSync(path.join(path.dirname(src), dep), 'utf8')
  if (/from "\.\/chunk-\w+\.mjs"/.test(depText)) throw new Error(`${dep} imports another chunk`)
  const { names, enums } = declared(depText)
  fs.writeFileSync(
    path.join(path.dirname(out), dep),
    depText +
      `\nexport const __schemas = {\n${list(names)}\n};\nexport const __enums = {\n${list(enums)}\n};\n`,
  )
  imports.push(`import { __schemas as __schemas${i}, __enums as __enums${i} } from "./${dep}";`)
  spreadSchemas.push(`  ...__schemas${i},`)
  spreadEnums.push(`  ...__enums${i},`)
  console.log(dep, 'enums', enums.size, 'schemas', names.size)
})

const { names, enums } = declared(text)
const body = text.replace(/\nexport \{[\s\S]*?\};\s*$/, '\n')
fs.writeFileSync(
  out,
  body +
    (imports.length ? '\n' + imports.join('\n') + '\n' : '') +
    '\nexport const __schemas = {\n' +
    [...spreadSchemas, list(names)].join('\n') +
    '\n};\nexport const __enums = {\n' +
    [...spreadEnums, list(enums)].join('\n') +
    '\n};\n',
)
console.log('enums', enums.size)
console.log('schemas', names.size)
