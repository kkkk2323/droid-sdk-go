# droid-sdk-go

A Go client for the Droid Daemon (`droid daemon`), the JSON-RPC-over-WebSocket
protocol that Factory's TypeScript SDK (`@factory/droid-sdk`) speaks. Pure Go,
no Node at run time.

Checked against `droid daemon` 0.233.0 (protocol 1.245.0); types generated from
`@factory/droid-sdk` 0.9.1 (protocol 1.201.1).

```sh
go get github.com/kkkk2323/droid-sdk-go@latest
```

It started in [droi](https://github.com/kkkk2323/droi), which still uses it, with
the Fake Daemon below.

## Packages

| Package        | What it is                                                                                                                                                                                                                                                                           | Written by         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `protocol`     | Every type of the protocol (660), method and notification names, per-method ack/timeout table                                                                                                                                                                                        | generated (`gen/`) |
| `droid` (root) | `Client`: one authenticated connection; a typed method for each of the 132 RPCs (`zz_client_methods.go`, generated), `Call`, `Subscribe`, `Handle`/`HandleLater`/`Respond` for the Daemon's own requests, frame recording                                                            | hand               |
| `controller`   | Connects and authenticates, reconnects and reloads Sessions, loads a Session before a call that needs its worker, tracks permission and AskUser prompts (keeping an answer given while a worker is gone until it is back), feeds the store. Port of the TS `DaemonSessionController` | hand               |
| `session`      | The Sessions' state: transcript built from streamed deltas, working state, settings, token usage, todos, queued and optimistic messages, subagents, display filtering. Port of the TS `MultiSessionStateManager`/`SessionStateManager`/`SessionStore`. No I/O                        | hand               |
| `fakedaemon`   | Runs the Fake Daemon (Node) for Go tests                                                                                                                                                                                                                                             | hand               |

## Use

```go
ctl := controller.New(controller.Config{
	URL: "ws://127.0.0.1:37643",
	Credential: func(context.Context) (*droid.Credential, error) {
		return &droid.Credential{APIKey: os.Getenv("FACTORY_API_KEY")}, nil
	},
})
defer ctl.Close()
if err := ctl.Connect(ctx); err != nil { ... }

ctl.Subscribe(func(e controller.Event) {
	if p, ok := e.(controller.PermissionRequested); ok {
		ctl.RespondToPermission(ctx, p.Permission.RequestID,
			controller.PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedOnce})
	}
})
ctl.Store().Subscribe(func(e session.Event) { /* re-render e.SessionID */ })

res, _ := ctl.InitializeSession(ctx, protocol.InitializeSessionParams{Cwd: dir})
ctl.AddUserMessage(ctx, protocol.AddUserMessageParams{SessionID: res.SessionID, Text: "Run the tests"})
msgs := ctl.Store().Session(res.SessionID).DisplayMessages()

cl, _ := ctl.Client() // every other RPC: cl.GetGitDiff, cl.ListSkills, ...
```

The full example is `controller/example_test.go`. The Controller wraps the
calls that change its state (`LoadSession`, `InitializeSession`,
`AddUserMessage`, `InterruptSession`, `CloseSession`, `RespondToPermission`,
`RespondToAskUser`); the rest go straight to the generated methods of
`ctl.Client()`. `droid.Dial` alone gives the bare connection.

Threading: Controller events come in order on a goroutine of their own, so a
handler may call the Controller. Store events come on the goroutine that
changed the store (for notifications, the connection's read goroutine): a
store subscriber must not block.

## What the Go port leaves out of the TS SDK

- Cloud machines, relays, computers, missions, terminals, act-as grants,
  telemetry. The Controller is for a local Daemon or a Gateway in front of
  one.
- After a reconnect the Controller loads again, at once, every Session that
  was loaded (TS marks them not loaded and loads on next use). It also loads
  on next use, as TS does.
- The TS reconnect grace window for a prompt that a first snapshot omits is
  not ported: a reload replaces a Session's prompts with the Daemon's.
- `InterruptSession` does not remove the half-streamed message (the store
  does not track streaming message ids); the Daemon's own notifications
  settle it.
- The store leaves out progressive rendering, LRU eviction, MCP status, hook
  rows and the pending/default settings stores; `session/store.go` lists all
  of it.

## Protocol facts found on a real Daemon

- `daemon.authenticate` with caller `sdk` and no `metadata.sdk` fails with
  -32700; `metadata.sdk.language` only takes `typescript` or `python`. The
  Client sends caller `go-sdk` and no SDK metadata.
- `daemon.add_user_message` answers `{}` (no ack), then `create_message`
  carries the request id; a message sent while the agent works is taken into
  the running turn at once.
- Empty `user_only` user messages are stored but never sent as
  notifications; a store matches `get_session_messages` without them.
- `get_session_messages` refuses `limit: 500` (100 works).
- An unknown Session is -32004 (`controller.ErrSessionNotFound`).
- Fields newer than the 0.9.1 schemas: `seq` on `create_message` and
  messages, `migrationActive` on settings. Decoding ignores them.
- Spec mode (droid 0.244): ExitSpecMode asks with `exit_spec_mode` details
  that say `supportsClientStartedHandoff`. Answered with a
  `proceed_new_session*` option and `clientStartsHandoffSession`, the
  Daemon creates the new Session without starting it
  (`spec_handoff_session_created`, newer than the 0.9.1 schemas) and the
  Client loads it and sends the plan: `PermissionAnswer.ClientStartsHandoffSession`,
  reported by `SpecHandoffStarted` or `SpecHandoffFailed`.

## Fake Daemon

`fake-daemon/` is a scripted stand-in for `droid daemon` and for droi's
Gateway in front of it (Pairing Token, `/meta`, Scratch Workspaces, session
files). It speaks the Daemon's protocol over WebSocket, replays a Scenario
instead of running an agent, and checks every message it sends with
`@factory/droid-sdk`'s zod schemas (patched as droi patches them, in
`patches/`). Clients' tests run against it, so they never need a Factory key.

- **Go:** `fakedaemon.Start(t, scenario)` runs it in Node and gives its URL.
  The package embeds the Fake Daemon bundled into one script
  (`fakedaemon/fake-daemon.mjs`), so a test needs only `node` on PATH.
  `fakedaemon.Turn` scripts the agent: a reply, a permission, AskUser, a
  todo list, structured output, or `spec` (ExitSpecMode and its handoff, as
  droid 0.244 does them).
- **TypeScript:** the npm package `@droi/fake-daemon` (`fake-daemon/`, with its
  built `dist/`), installed from this repository's tag:

  ```json
  "@droi/fake-daemon": "github:kkkk2323/droid-sdk-go#v0.2.1&path:/fake-daemon"
  ```

  `import { FakeDaemon } from '@droi/fake-daemon/fake-daemon'`. Set
  `FakeDaemon.appVersion` to the Droi version `/meta` should answer.

After changing `fake-daemon/` or `fakedaemon/serve.ts`, run `pnpm build` and
commit what it writes (`fake-daemon/dist`, `fakedaemon/fake-daemon.mjs`); CI
fails when they are out of date.

## Tests

```sh
pnpm install && pnpm typecheck
go test -race ./...      # unit + Fake Daemon (skipped without Node)
```

Live tests run a throwaway `droid daemon` in a temporary HOME:

```sh
FACTORY_API_KEY=fk-... [FACTORY_API_BASE_URL=...] [DROID_LIVE_MODEL=...] \
  DROID_LIVE_RECORD=testdata/live go test -run 'Live|Replay' -v .
```

They cover a turn, a permission, a message sent while busy (store transcript
equal to the Daemon's), settings, rename/archive/search, paging, context
breakdown, skills, commands, MCP, git diff, file content, an unknown Session,
a Daemon restart mid-Session (reconnect, reload, next turn) and compaction.
`TestReplayRecordings` decodes every recorded frame (credentials redacted)
with the generated types and lists fields they lack, so protocol drift shows
without a network.

## Upgrading to a new `@factory/droid-sdk`

```sh
gen/generate.sh 0.10.0 && go build ./... && go test -race ./...
```

`generate.sh` installs that release from npm, pulls the zod schemas and the
DaemonClient method table out of its bundle, and rewrites `protocol/` and
`zz_client_methods.go` (same version in, same bytes out). The compiler then
points at the hand-written code that uses what changed.

Measured on 0.8.0 → 0.9.1: 11 types added or renamed, ~500 changed lines of
generated code, the same 132 methods, and 6 compile errors, all in `session`
where it uses what 0.9 added (message retraction, rich message content).
Regenerating takes about a minute; porting the new behaviour of a release is
hand work on the TS sources (split readable with `gen/split.cjs`), typically
hours, mostly in `session` and `controller`.
