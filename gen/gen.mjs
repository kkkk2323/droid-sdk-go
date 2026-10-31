// Generates the Go protocol package from the zod schemas bundled in
// @factory/droid-sdk, so a new SDK release is one `go generate` away.
//
//   node gen.mjs <exposed chunk.mjs> <methods.json> <out dir>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [chunkPath, methodsPath, outDir] = process.argv.slice(2)
const { __schemas: all, __enums: enums } = await import(pathToFileURL(path.resolve(chunkPath)).href)
const enumNames = new Map() // TS enum object -> its name
for (const [k, v] of Object.entries(enums))
  if (v && typeof v === 'object' && !enumNames.has(v)) enumNames.set(v, k)
const methods = JSON.parse(fs.readFileSync(methodsPath, 'utf8'))
const sdkVersion = process.env.SDK_VERSION ?? 'unknown'

// ---------- naming ----------

const INITIALISMS = {
  Id: 'ID',
  Ids: 'IDs',
  Url: 'URL',
  Urls: 'URLs',
  Api: 'API',
  Mcp: 'MCP',
  Json: 'JSON',
  Http: 'HTTP',
  Https: 'HTTPS',
  Uri: 'URI',
  Cwd: 'Cwd',
  Llm: 'LLM',
  Pr: 'PR',
  Ui: 'UI',
  Os: 'OS',
  Ssh: 'SSH',
  Sha: 'SHA',
  Ttl: 'TTL',
  Ip: 'IP',
  Html: 'HTML',
  Sdk: 'SDK',
  Cli: 'CLI',
  Tui: 'TUI',
  Oauth: 'OAuth',
  Ws: 'WS',
}
function words(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}
function pascal(s) {
  let out = words(s)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .map(
      (w) => INITIALISMS[w] ?? (w === w.toUpperCase() && w.length > 1 && /[A-Z]/.test(w) ? w : w),
    )
    .join('')
  if (!out) out = 'X'
  if (/^[0-9]/.test(out)) out = 'V' + out
  return out
}

const taken = new Map() // Go name -> schema
const nameOf = new Map() // schema -> Go name
function claim(schema, want) {
  let name = want
  for (let i = 2; taken.has(name) && taken.get(name) !== schema; i++) name = want + i
  taken.set(name, schema)
  nameOf.set(schema, name)
  return name
}

const varNames = new Map() // schema -> [var names]
for (const [k, v] of Object.entries(all)) {
  if (!v || typeof v !== 'object' || !v._def) continue
  if (!varNames.has(v)) varNames.set(v, [])
  varNames.get(v).push(k)
}
function varName(schema) {
  const names = varNames.get(schema)
  if (!names) return null
  const base = names
    .map((n) => n.replace(/Schema\d*$/, '').replace(/\d+$/, ''))
    .sort((a, b) => a.length - b.length)[0]
  return base ? pascal(base) : null
}

// ---------- zod walking ----------

const tn = (s) => s._def.typeName
function unwrap(s) {
  // Peels wrappers that do not change the JSON shape; reports optionality.
  let optional = false,
    nullable = false
  for (;;) {
    const t = tn(s)
    if (t === 'ZodOptional') {
      optional = true
      s = s._def.innerType
      continue
    }
    if (t === 'ZodDefault') {
      optional = true
      s = s._def.innerType
      continue
    }
    if (t === 'ZodNullable') {
      nullable = true
      s = s._def.innerType
      continue
    }
    if (t === 'ZodEffects') {
      s = s._def.schema
      continue
    }
    if (t === 'ZodBranded') {
      s = s._def.type
      continue
    }
    if (t === 'ZodReadonly' || t === 'ZodCatch') {
      s = s._def.innerType
      continue
    }
    if (t === 'ZodPipeline') {
      s = s._def.in
      continue
    }
    if (t === 'ZodLazy') {
      s = s._def.getter()
      continue
    }
    return { s, optional, nullable }
  }
}
function shapeOf(obj) {
  return typeof obj._def.shape === 'function' ? obj._def.shape() : obj.shape
}
function literalUnionValues(s) {
  const t = tn(s)
  if (t === 'ZodLiteral') return [s._def.value]
  if (t === 'ZodEnum') return [...s._def.values]
  if (t === 'ZodNativeEnum')
    return Object.entries(s._def.values)
      .filter(([k]) => !/^\d+$/.test(k))
      .map(([, v]) => v)
  if (t === 'ZodUnion') {
    const out = []
    for (const o of s._def.options) {
      const u = unwrap(o).s
      const v = literalUnionValues(u)
      if (!v) return null
      out.push(...v)
    }
    return out
  }
  return null
}
function discriminatorOf(s) {
  const t = tn(s)
  if (t === 'ZodDiscriminatedUnion') return s._def.discriminator
  if (t !== 'ZodUnion') return null
  const opts = s._def.options.map((o) => unwrap(o).s)
  if (!opts.every((o) => tn(o) === 'ZodObject')) return null
  for (const key of ['type', 'kind', 'status', 'method', 'success']) {
    const vals = opts.map((o) => {
      const f = shapeOf(o)[key]
      return f && tn(unwrap(f).s) === 'ZodLiteral' ? unwrap(f).s._def.value : undefined
    })
    if (
      (vals.every((v) => typeof v === 'string') || vals.every((v) => typeof v === 'boolean')) &&
      new Set(vals).size === vals.length
    )
      return key
  }
  return null
}
function unionOptions(s) {
  return (tn(s) === 'ZodDiscriminatedUnion' ? [...s._def.options] : s._def.options).map(
    (o) => unwrap(o).s,
  )
}

// ---------- Go emission ----------

const decls = [] // Go source chunks, in order
const emitted = new Set()
const queue = []

function typeRef(schema, hint) {
  // Returns the Go type for a schema, emitting named types as needed.
  const { s } = unwrap(schema)
  const t = tn(s)
  switch (t) {
    case 'ZodString':
    case 'ZodDate':
      return 'string'
    case 'ZodNumber':
      return s._def.checks?.some((c) => c.kind === 'int') ? 'int64' : 'float64'
    case 'ZodBigInt':
      return 'int64'
    case 'ZodBoolean':
      return 'bool'
    case 'ZodAny':
    case 'ZodUnknown':
    case 'ZodTuple':
    case 'ZodNull':
    case 'ZodUndefined':
    case 'ZodVoid':
    case 'ZodNever':
    case 'ZodFunction':
    case 'ZodPromise':
      return 'json.RawMessage'
    case 'ZodArray':
      return '[]' + typeRef(s._def.type, hint + 'Item')
    case 'ZodSet':
      return '[]' + typeRef(s._def.valueType, hint + 'Item')
    case 'ZodRecord':
    case 'ZodMap':
      return 'map[string]' + typeRef(s._def.valueType, hint + 'Value')
    case 'ZodLiteral': {
      const v = s._def.value
      return typeof v === 'string'
        ? 'string'
        : typeof v === 'boolean'
          ? 'bool'
          : typeof v === 'number'
            ? 'float64'
            : 'json.RawMessage'
    }
    case 'ZodEnum':
    case 'ZodNativeEnum':
      return named(s, hint, false, () => emitEnum(s))
    case 'ZodObject':
      return named(s, hint, true, () => emitStruct(s))
    case 'ZodIntersection': {
      const l = unwrap(s._def.left).s,
        r = unwrap(s._def.right).s
      if (tn(l) === 'ZodObject' && tn(r) === 'ZodObject')
        return named(s, hint, true, () => emitStruct(s, { ...shapeOf(l), ...shapeOf(r) }))
      return 'json.RawMessage'
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const lits = literalUnionValues(s)
      if (lits && lits.every((v) => typeof v === 'string'))
        return named(s, hint, false, () => emitEnum(s, lits))
      if (lits) return 'json.RawMessage'
      const opts = s._def.options.map((o) => unwrap(o).s)
      const nonNull = opts.filter((o) => !['ZodNull', 'ZodUndefined'].includes(tn(o)))
      if (nonNull.length === 1) return typeRef(nonNull[0], hint)
      if (discriminatorOf(s)) return named(s, hint, true, () => emitUnion(s))
      // string | string[] and other mixes stay raw.
      return 'json.RawMessage'
    }
    default:
      throw new Error('unhandled zod type ' + t + ' at ' + hint)
  }
}

// The same enum, made by z.nativeEnum(E) or z.enum([...]) at every use,
// is one Go type.
const enumByKey = new Map()
function enumKey(s) {
  if (tn(s) === 'ZodNativeEnum') return s._def.values
  const v = literalUnionValues(s)
  return v ? 'enum:' + JSON.stringify([...v].sort()) : null
}

function named(s, hint, isStruct, emit) {
  if (!isStruct) {
    const key = enumKey(s)
    const seen = key && enumByKey.get(key)
    if (seen) return seen
    if (key) {
      const want =
        (tn(s) === 'ZodNativeEnum' &&
          enumNames.get(s._def.values) &&
          pascal(enumNames.get(s._def.values))) ||
        varName(s) ||
        hint
      const name = nameOf.get(s) ?? claim(s, want)
      enumByKey.set(key, name)
      emitted.add(s)
      queue.push(() => decls.push(emit()))
      return name
    }
  }
  let name = nameOf.get(s)
  if (!name) name = claim(s, varName(s) ?? hint)
  if (!emitted.has(s)) {
    emitted.add(s)
    if (isStruct) structNames.add(name)
    queue.push(() => decls.push(emit()))
  }
  return name
}

function goField(key) {
  let f = pascal(key)
  if (key.startsWith('_')) f = 'X' + f
  return f
}
const structNames = new Set()

function describe(s) {
  const d = s.description ?? s._def.description
  return d ? d.replace(/\s+/g, ' ').trim() : ''
}
function comment(text, indent = '') {
  if (!text) return ''
  return text
    .split(/(?<=\.) /)
    .map((l) => `${indent}// ${l}\n`)
    .join('')
}

// Fields droid's Daemon sends that the @factory/droid-sdk release the types
// come from does not have yet. Kept here so that regenerating keeps them; a
// release that adds one makes its entry here a duplicate, which gen fails on.
const NEWER_FIELDS = {
  AskUserParams: [
    ['blocking', '*bool', 'False for a queued question set (droid 1.1): the agent keeps working and the answers reach it later. Absent means blocking.'],
    ['context', 'string', "A queued question set's self-contained explanation (droid 1.1), shown above its questions."],
  ],
  LoadSessionResultPendingAskUserRequestsItem: [
    ['blocking', '*bool', 'False for a queued question set (droid 1.1). Absent means blocking.'],
    ['context', 'string', "A queued question set's explanation (droid 1.1)."],
  ],
  ModelMetadata: [
    ['behavesLikeModelId', 'string', "For a custom model, the built-in model whose behavior it inherits (droid 1.1): its baseModelId, else the closest built-in to its upstream model id. Absent when nothing matches, and from older Daemons."],
  ],
  DroidWorkingStateChangedNotification: [
    ['backgroundWork', '*int64', 'Sent when the Session goes idle (droid 1.0): the background work it still waits on (background commands, Script runs, subagent results still owed), any of which wakes it later. Absent from older Daemons.'],
  ],
  LoadSessionResult: [
    ['backgroundWork', '*int64', 'The background work the Session waits on at load time, as droid_working_state_changed reports it (droid 1.0).'],
    ['backgroundProcesses', '*SessionBackgroundProcessesSnapshot', 'The background processes the Session tracks at load time (droid 1.0). Absent from older Daemons, which also do not handle daemon.kill_background_process.'],
  ],
}

// Types and methods of droid's Daemon that the release lacks, named as the
// generator would name them from droid's own schemas. A release that has
// one makes it a duplicate, which gen fails on.
const NEWER_TYPES = {
  SessionBackgroundProcess: `// SessionBackgroundProcess is a background process a Session started (a
// fire-and-forget Execute) that still runs on the computer hosting the
// Session (droid 1.0). Pid and OutputFile are of that computer, which may not
// be the Client's.
type SessionBackgroundProcess struct {
	// Stable identifier: the starting tool call's id when known.
	ID          string  \`json:"id"\`
	Pid         float64 \`json:"pid"\`
	Command     string  \`json:"command"\`
	StartedAtMs float64 \`json:"startedAtMs"\`
	ToolUseID   string  \`json:"toolUseId,omitempty"\`
	OutputFile  string  \`json:"outputFile,omitempty"\`
}
`,
  SessionBackgroundProcessesSnapshot: `// SessionBackgroundProcessesSnapshot is every background process a Session
// tracks, as of CapturedAtMs on the Session host's clock (droid 1.0).
type SessionBackgroundProcessesSnapshot struct {
	CapturedAtMs float64                    \`json:"capturedAtMs"\`
	Processes    []SessionBackgroundProcess \`json:"processes"\`
}
`,
  BackgroundProcessesChangedNotification: `// BackgroundProcessesChangedNotification (session notification
// background_processes_changed, droid 1.0) is a Session's background
// processes after one started or ended.
type BackgroundProcessesChangedNotification struct {
	Type         string                     \`json:"type"\`
	CapturedAtMs float64                    \`json:"capturedAtMs"\`
	Processes    []SessionBackgroundProcess \`json:"processes"\`
}
`,
  KillBackgroundProcessParams: `type KillBackgroundProcessParams struct {
	SessionID string \`json:"sessionId"\`
	ProcessID string \`json:"processId"\`
}
`,
  KillBackgroundProcessResult: `type KillBackgroundProcessResult struct {
	// False when the Session tracks no running process with that id, or the
	// process could not be signalled.
	Killed bool \`json:"killed"\`
}
`,
}
const NEWER_METHODS = [
  { rpc: 'daemon.kill_background_process', paramsType: 'KillBackgroundProcessParams', resultType: 'KillBackgroundProcessResult' },
]

function emitStruct(s, shape = shapeOf(s)) {
  const name = nameOf.get(s)
  {
    const lines = []
    const used = new Set()
    for (const [key, field] of Object.entries(shape)) {
      const { s: base, optional, nullable } = unwrap(field)
      let f = goField(key)
      while (used.has(f)) f += '_'
      used.add(f)
      let ty = typeRef(field, name + f)
      const ptr =
        (optional || nullable) &&
        (ty === 'bool' || ty === 'int64' || ty === 'float64' || structNames.has(ty))
      if (ptr) ty = '*' + ty
      const tag = optional || nullable ? `json:"${key},omitempty"` : `json:"${key}"`
      lines.push(comment(describe(field) || describe(base), '\t') + `\t${f} ${ty} \`${tag}\``)
    }
    for (const [key, ty, doc] of NEWER_FIELDS[name] ?? []) {
      const f = goField(key)
      if (used.has(f)) throw new Error(`${name}.${key} is in the schemas now: drop it from NEWER_FIELDS`)
      used.add(f)
      lines.push(comment(doc, '\t') + `\t${f} ${ty} \`json:"${key},omitempty"\``)
    }
    return `${comment(describe(s))}type ${name} struct {\n${lines.join('\n')}\n}\n`
  }
}

function emitEnum(s, values = literalUnionValues(s)) {
  const name = nameOf.get(s)
  {
    const strs = values.every((v) => typeof v === 'string')
    const base = strs ? 'string' : 'float64'
    const consts = values.map(
      (v) => `\t${constName(name + pascal(String(v)))} ${name} = ${JSON.stringify(v)}`,
    )
    return `${comment(describe(s))}type ${name} ${base}\n\nconst (\n${consts.join('\n')}\n)\n`
  }
}

function emitUnion(s) {
  const name = nameOf.get(s)
  const disc = discriminatorOf(s)
  const opts = unionOptions(s)
  {
    const goDisc = goField(disc)
    const cases = []
    for (const o of opts) {
      // A branch's discriminator may be a z.enum: one case per value, one shape.
      const d = unwrap(shapeOf(o)[disc]).s
      const vs = tn(d) === 'ZodLiteral' ? [d._def.value] : literalUnionValues(d)
      const member = typeRef(o, name + pascal(vs[0]))
      for (const v of vs) cases.push({ v, member, c: constName(name + goDisc + pascal(v)) })
    }
    const goKind =
      typeof cases[0].v === 'boolean'
        ? 'bool'
        : typeof cases[0].v === 'number'
          ? 'float64'
          : 'string'
    const consts = cases.map(({ v, c }) => `\t${c} ${goKind} = ${JSON.stringify(v)}`)
    const groups = []
    for (const { c, member } of cases) {
      const g = groups.find((g) => g.member === member)
      if (g) g.cs.push(c)
      else groups.push({ member, cs: [c] })
    }
    const sw = groups.map(
      ({ cs, member }) =>
        `\tcase ${cs.join(', ')}:\n\t\tvar v ${member}\n\t\terr := json.Unmarshal(u.Raw, &v)\n\t\treturn &v, err`,
    )
    return `${comment(describe(s))}// ${name} is one of several shapes, told apart by its ${JSON.stringify(disc)} field.
// Value decodes it into the shape that ${goDisc} names.
type ${name} struct {
	${goDisc} ${goKind}
	Raw json.RawMessage
}

const (
${consts.join('\n')}
)

func (u *${name}) UnmarshalJSON(b []byte) error {
	var head struct {
		D ${goKind} \`json:${JSON.stringify(disc)}\`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return err
	}
	u.${goDisc}, u.Raw = head.D, append(json.RawMessage(nil), b...)
	return nil
}

func (u ${name}) MarshalJSON() ([]byte, error) {
	if u.Raw == nil {
		return []byte("null"), nil
	}
	return u.Raw, nil
}

// Value returns a pointer to the shape the ${goDisc} names, or nil and no
// error for a ${goDisc} this version of the protocol does not know.
func (u ${name}) Value() (any, error) {
	switch u.${goDisc} {
${sw.join('\n')}
	}
	return nil, nil
}

// New${name} wraps one of its shapes.
func New${name}(v any) (${name}, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return ${name}{}, err
	}
	var u ${name}
	return u, u.UnmarshalJSON(b)
}
`
  }
}

function constName(want) {
  return claim({}, want)
}

function drain() {
  while (queue.length) queue.shift()()
}

// ---------- roots ----------

for (const n of NEWER_METHODS) {
  if (methods.some((m) => m.rpc === n.rpc)) throw new Error(`${n.rpc} is in the release now: drop it from NEWER_METHODS`)
  const base = pascal(n.rpc.replace(/^daemon\./, ''))
  methods.push({ name: n.rpc, rpc: n.rpc, ack: false, done: [], newer: { ...n, goName: base, base, paramsOptional: false } })
}

// Daemon-initiated requests and notifications, found by their envelopes. A
// request envelope that is not in the DaemonClient table is the Daemon's own
// request only when DaemonDroidEvent names it (ask_user, pick_options, ...);
// the rest (get_git_branch_divergence, warmup_cache, desktop.status) are
// methods the Daemon serves that the TS client does not call, added to the
// table with the result their response envelope carries.
function envelopeResult(requestVar) {
  const env = all[requestVar.replace(/RequestSchema$/, 'ResponseSchema')]
  if (!env) return null
  for (const o of tn(env) === 'ZodUnion' ? env._def.options : [env]) {
    const u = unwrap(o).s
    if (tn(u) === 'ZodObject' && shapeOf(u).result) return shapeOf(u).result
  }
  return null
}
const serverRequests = [],
  notifications = []
const daemonEvents = new Set(Object.values(enums.DaemonDroidEvent ?? {}))
for (const [k, v] of Object.entries(all)) {
  if (!v?._def || tn(v) !== 'ZodObject') continue
  const sh = shapeOf(v)
  const type = sh.type && unwrap(sh.type).s,
    method = sh.method && unwrap(sh.method).s
  if (!type || !method || tn(type) !== 'ZodLiteral' || tn(method) !== 'ZodLiteral') continue
  const m = method._def.value
  if (typeof m !== 'string' || !m.startsWith('daemon.') || !sh.params) continue
  const entry = { var: k, method: m, params: sh.params }
  if (type._def.value === 'notification' && !notifications.some((n) => n.method === m))
    notifications.push(entry)
  if (
    type._def.value !== 'request' ||
    methods.some((x) => x.rpc === m) ||
    serverRequests.some((n) => n.method === m)
  )
    continue
  const res = 'Daemon' + pascal(m.replace(/^daemon\./, '')) + 'ResultSchema'
  const resSchema = all[res] ?? envelopeResult(k)
  if (daemonEvents.size && !daemonEvents.has(m) && resSchema)
    methods.push({ name: m, rpc: m, req: k, res, resSchema, ack: false, done: [] })
  else serverRequests.push(entry)
}

const methodEntries = []
for (const m of methods) {
  if (m.newer) {
    methodEntries.push({ ...m, ...m.newer })
    continue
  }
  const reqSchema = all[m.req],
    resSchema = m.resSchema ?? all[m.res]
  if (!reqSchema || !resSchema) throw new Error('missing schema for ' + m.name)
  const base = pascal(m.rpc.replace(/^daemon\./, ''))
  const paramsField = shapeOf(unwrap(reqSchema).s).params
  let paramsType = null
  if (paramsField) {
    const p = unwrap(paramsField).s
    if (tn(p) === 'ZodObject' && Object.keys(shapeOf(p)).length === 0) paramsType = 'struct{}'
    else {
      if (!nameOf.has(p) && tn(p) === 'ZodObject') claim(p, base + 'Params')
      paramsType = typeRef(paramsField, base + 'Params')
    }
  }
  const r = unwrap(resSchema).s
  if (!nameOf.has(r) && tn(r) === 'ZodObject')
    claim(r, varName(r) && !/^Daemon/.test(varName(r)) ? varName(r) : base + 'Result')
  const resultType = typeRef(resSchema, base + 'Result')
  methodEntries.push({
    ...m,
    goName: base,
    base,
    paramsType,
    paramsOptional: paramsField ? unwrap(paramsField).optional : true,
    resultType,
  })
}

for (const n of [...notifications, ...serverRequests]) {
  const base = pascal(n.method.replace(/^daemon\./, ''))
  const p = unwrap(n.params).s
  if (!nameOf.has(p) && tn(p) === 'ZodObject') claim(p, base + 'Params')
  n.goType = typeRef(n.params, base + 'Params')
  n.base = base
  // What the Client answers a daemon request with.
  const res = all['Daemon' + base + 'ResultSchema']
  if (serverRequests.includes(n) && res) {
    const r = unwrap(res).s
    if (!nameOf.has(r)) claim(r, base + 'Response')
    n.responseType = typeRef(res, base + 'Response')
  }
}

// Types the Clients use directly.
for (const k of [
  'FactoryDroidMessageSchema',
  'SessionNotificationPayloadSchema',
  'ContentBlockSchema',
  'DroidWorkingStateSchema',
  'ToolConfirmationDetailsSchema',
  'AskUserResultSchema',
  'PermissionResponseSchema',
]) {
  if (all[k]) typeRef(all[k], pascal(k.replace(/Schema$/, '')))
}
drain()
for (const [name, decl] of Object.entries(NEWER_TYPES)) {
  if (taken.has(name)) throw new Error(`${name} is in the schemas now: drop it from NEWER_TYPES`)
  claim({}, name)
  decls.push(decl)
}

// ---------- files ----------

const header = `// Code generated by gen/gen.mjs from @factory/droid-sdk ${sdkVersion}. DO NOT EDIT.\n\n`
fs.mkdirSync(outDir, { recursive: true })
const protocolVersion = /var FACTORY_PROTOCOL_VERSION = "([^"]+)"/.exec(
  fs.readFileSync(chunkPath, 'utf8'),
)?.[1]
if (!protocolVersion) throw new Error('FACTORY_PROTOCOL_VERSION not found')
const needsJSON = decls.some((d) => d.includes('json.'))
fs.writeFileSync(
  path.join(outDir, 'zz_types.go'),
  header +
    'package protocol\n\n' +
    (needsJSON ? 'import "encoding/json"\n\n' : '') +
    decls.join('\n'),
)

const timeouts = {
  '3e5': '300 * time.Second',
  '18e4': '180 * time.Second',
  COMPACTION_REQUEST_TIMEOUT: '240 * time.Second',
  FILE_TRANSFER_REQUEST_TIMEOUT: '900 * time.Second',
}
const mlines = methodEntries.map((m) => {
  const done = m.done.length ? JSON.stringify(m.done[0]) : '""'
  const to = timeouts[m.timeout] ?? '0'
  return `\t${JSON.stringify(m.rpc)}: {Ack: ${m.ack}, CompletedBy: ${done}, Timeout: ${to}},`
})
const consts = methodEntries.map((m) => `\tMethod${m.base} = ${JSON.stringify(m.rpc)}`)
const nconsts = notifications.map((n) => `\tNotification${n.base} = ${JSON.stringify(n.method)}`)
const rconsts = serverRequests.map((n) => `\tServerRequest${n.base} = ${JSON.stringify(n.method)}`)
const methodsUseJSON = methodEntries.some(
  (m) => m.resultType.startsWith('json.') || (m.paramsType ?? '').startsWith('json.'),
)
fs.writeFileSync(
  path.join(outDir, 'zz_methods.go'),
  header +
    `package protocol

import (
${methodsUseJSON ? '\t"encoding/json"\n' : ''}\t"time"
)

// SDKVersion is the @factory/droid-sdk release the protocol was generated from.
const SDKVersion = ${JSON.stringify(sdkVersion)}

// FactoryProtocolVersion is the protocol version requests carry.
const FactoryProtocolVersion = ${JSON.stringify(protocolVersion)}

// Methods the Client calls on the Daemon.
const (
${consts.join('\n')}
)

// Notifications the Daemon sends.
const (
${nconsts.join('\n')}
)

// Requests the Daemon sends the Client, which it must answer.
const (
${rconsts.join('\n')}
)

// MethodInfo is how a method is answered.
type MethodInfo struct {
	// Ack: the Daemon may answer {"accepted": true} at once and complete the
	// request later with a session notification of type CompletedBy that
	// carries the request's id.
	Ack         bool
	CompletedBy string
	// Timeout replaces the Client's default request timeout when not 0.
	Timeout time.Duration
}

// NewParams returns a pointer to a new value of a method's params type, or
// nil for an unknown method.
func NewParams(method string) any {
	switch method {
${methodEntries
  .filter((m) => m.paramsType && m.paramsType !== 'struct{}')
  .map((m) => `\tcase Method${m.base}:\n\t\treturn new(${m.paramsType})`)
  .join('\n')}
	}
	return nil
}

// NewResult returns a pointer to a new value of a method's result type, or
// nil for an unknown method.
func NewResult(method string) any {
	switch method {
${methodEntries.map((m) => `\tcase Method${m.base}:\n\t\treturn new(${m.resultType})`).join('\n')}
	}
	return nil
}

// Methods describes every method in the table above.
var Methods = map[string]MethodInfo{
${mlines.join('\n')}
}
`,
)

// Typed wrappers on the root package's Client.
const wrappers = methodEntries.map((m) => {
  const doc = `// ${m.goName} calls ${m.rpc}.\n`
  const res = m.resultType.startsWith('json.') ? 'json.RawMessage' : 'protocol.' + m.resultType
  if (!m.paramsType) {
    return `${doc}func (c *Client) ${m.goName}(ctx context.Context) (*${res.replace(/^json\./, 'json.')}, error) {\n\tvar out ${res}\n\treturn &out, c.Call(ctx, protocol.Method${m.base}, nil, &out)\n}\n`
  }
  const p =
    m.paramsType === 'struct{}'
      ? null
      : m.paramsType.startsWith('json.')
        ? 'json.RawMessage'
        : 'protocol.' + m.paramsType
  if (!p)
    return `${doc}func (c *Client) ${m.goName}(ctx context.Context) (*${res}, error) {\n\tvar out ${res}\n\treturn &out, c.Call(ctx, protocol.Method${m.base}, struct{}{}, &out)\n}\n`
  return `${doc}func (c *Client) ${m.goName}(ctx context.Context, params ${p}) (*${res}, error) {\n\tvar out ${res}\n\treturn &out, c.Call(ctx, protocol.Method${m.base}, params, &out)\n}\n`
})
const usesJSON = wrappers.some((w) => w.includes('json.'))
fs.writeFileSync(
  path.join(outDir, '..', 'zz_client_methods.go'),
  header +
    `package droid

import (
	"context"
${usesJSON ? '\t"encoding/json"\n' : ''}
	"${process.env.GO_MODULE}/protocol"
)

${wrappers.join('\n')}`,
)

// A summary for the README and for reviewing what changed between releases.
fs.writeFileSync(
  path.join(outDir, '..', 'gen', 'protocol-summary.txt'),
  `@factory/droid-sdk ${sdkVersion}\n\nmethods (${methodEntries.length}):\n` +
    methodEntries
      .map((m) => `  ${m.rpc}${m.ack ? ' (ack, completed by ' + m.done[0] + ')' : ''}`)
      .join('\n') +
    `\n\nnotifications (${notifications.length}):\n` +
    notifications.map((n) => '  ' + n.method).join('\n') +
    `\n\ndaemon requests (${serverRequests.length}):\n` +
    serverRequests.map((n) => '  ' + n.method).join('\n') +
    '\n',
)
console.log(
  'types',
  decls.length,
  'methods',
  methodEntries.length,
  'notifications',
  notifications.length,
  'server requests',
  serverRequests.length,
)
