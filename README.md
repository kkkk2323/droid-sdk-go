# droid-sdk-go

A Go client for the Droid Daemon (`droid daemon`), the JSON-RPC-over-WebSocket
protocol that Factory's TypeScript SDK (`@factory/droid-sdk`) speaks. Pure Go,
no Node at run time.

Checked against `droid daemon` 0.233.0 (protocol 1.245.0) and used with droid 1.12;
types generated from `@factory/droid-sdk` 0.11.0 (protocol 1.332.0), which has
everything this package once added by hand for droid 1.0 to 1.2 (see "Upgrading" below).

```sh
go get github.com/kkkk2323/droid-sdk-go@latest
```

It started in [droi](https://github.com/kkkk2323/droi), which still uses it, with
the Fake Daemon below.

## Packages

| Package        | What it is                                                                                                                                                                                                                                                                           | Written by         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `protocol`     | Every type of the protocol (928), method and notification names, per-method ack/timeout table                                                                                                                                                                                        | generated (`gen/`) |
| `droid` (root) | `Client`: one authenticated connection; a typed method for each of the 160 RPCs (`zz_client_methods.go`, generated), `Call`, `Subscribe`, `Handle`/`HandleLater`/`Respond` for the Daemon's own requests, frame recording                                                            | hand               |
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

Long Sessions: `Messages` and `DisplayMessages` copy every message on each
call. A client that reads them after each change uses `ReadMessages` and
`ReadDisplayMessages`, which hand it the store's own slice under its lock,
kept up to date as messages are added or replaced. The store keeps every
message it loaded; `Store.TrimOlderMessages` lets go of all but the latest,
which `PrependOlderMessages` brings back.

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
- Spec mode (droid 0.244): ExitSpecMode asks with `exit_spec_mode` details
  that say `supportsClientStartedHandoff`. Answered with a
  `proceed_new_session*` option and `clientStartsHandoffSession`, the
  Daemon creates the new Session without starting it
  (`spec_handoff_session_created`) and the
  Client loads it and sends the plan: `PermissionAnswer.ClientStartsHandoffSession`,
  reported by `SpecHandoffStarted` or `SpecHandoffFailed`.
- Queued AskUser (droid 1.1): `daemon.ask_user` with `blocking: false` and
  a `context` queues a question set; the agent keeps working. The
  Controller marks it `AskUser.Queued`: it does not put the Session in
  waiting, survives the turn ending or `InterruptSession`, and goes when it
  is answered or the Daemon sends `ask_user_resolved` (another Client
  answered, or the set was asked again under a new id). Answers come back
  to the agent as a user message with id `ask-user-answer:<toolCallId>`,
  after a user-only system receipt `ask-user-receipt:<toolCallId>` that
  renderers skip.
- `child_session_settled` (droid 1.1) on a parent Session settles a Task
  child the Client may not reach (another computer): the store sets the
  child's summary status and its working state to idle.
- `behavesLikeModelId` on a custom model (droid 1.1) names the built-in
  model it behaves like.
- Background processes (droid 1.0): an Execute with `fireAndForget`
  answers `Background process started (PID: …)` and the Daemon reports the
  Session's processes with `background_processes_changed` (the whole list,
  `capturedAtMs` on the host's clock) and in load's `backgroundProcesses`.
  `Session.BackgroundProcesses` keeps them (cleared when the worker exits);
  `daemon.kill_background_process` (`Client.KillBackgroundProcess`) stops
  one, after which droid gives the agent the end as a model-only user
  message `execute-completion:<toolUseId>` that starts a turn.
- Queued messages across a dropped connection (droid 1.1's reconciliation):
  they stay shown; the reload's `pendingMessageRequestIds` keeps the ones
  the Daemon admitted and drops the rest, and none of them is sent again.
  Messages carry `seq`, the order the store keeps them in.
- AskUser option descriptions (droid 1.2): an Anthropic model may ask in
  Claude Code's AskUserQuestion shape (`questions[].options[].{label,
  description}`, behind Factory's `claude_question_option_descriptions`
  flag). The AskUser tool call's input then has `questions` and no
  `questionnaire`, and each question of `daemon.ask_user` carries
  `optionDescriptions`, index-aligned with `options`.
- A Session seeded from another one (droid 1.2's `seed` on
  `initialize_session`) can start with a trailing window of the copied
  history: initialize's `hasOlderMessages`, kept by the store as load's is.
- Automation run history (droid 1.2) carries `failureReason` and, when a
  user changed a run's outcome, `outcomeOverride` (the recorded outcome and
  who changed it); `status` is the changed outcome.
- `daemon.get_session_turn_outcome` (seen on droid 1.4.1) reads a turn's
  outcome from the Session's transcript once, `timeoutMs` bounding the
  read: it does not wait for a turn still running. The turn id is its
  prompt's message id. `available` carries the outcome (`resultKind`
  `text` for a turn without structured output) and `finalOutput`, the text
  of the last reply after the prompt; `unavailable` says
  `session_not_found` (no transcript), `turn_unverified` (no outcome for
  that prompt yet, or no such prompt) or `deadline_exceeded`.

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
  `fakedaemon.Turn` scripts the agent: a reply, a permission, AskUser (blocking or queued,
  with droid 1.2's option descriptions), a
  todo list, structured output, `spec` (ExitSpecMode and its handoff, as
  droid 0.244 does them), or `backgroundProcess` (an Execute left running in
  the background, with droid 1.0's launch text, `background_processes_changed`
  and `daemon.kill_background_process`). Its `load_session` reports the
  scripted turn's state: the agent loop running, held messages
  (`queuedMessages`), `pendingMessageRequestIds`, background processes and
  the permission requests no Client answered yet (`pendingPermissions`).
  `daemon.get_session_turn_outcome` answers from the turns it ran, or a
  test made up with `Notify` (a user message, then `agent_turn_completed`
  with its id), as droid 1.4.1 reads them from the transcript.
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
gen/generate.sh 0.11.0 && go build ./... && go test -race ./...
```

`generate.sh` installs that release from npm, pulls the zod schemas and the
DaemonClient method table out of its bundle, and rewrites `protocol/` and
`zz_client_methods.go` (same version in, same bytes out). What a newer
`droid` has that the release lacks is listed in `gen/gen.mjs`: fields on
generated structs in `NEWER_FIELDS`, whole types in `NEWER_TYPES` and
methods in `NEWER_METHODS`; generation fails once a release has one of
them itself. Against 0.11.0 all three are empty: 0.11.0 has every field,
type and method they held for droid 1.0 to 1.2.

`ask_user_resolved`, `child_session_settled` and
`background_processes_changed` are in the generated notification union since
0.11.0. The Controller handles `ask_user_resolved` by its type
(`controller/queued.go`); the store still reads the other two from their raw
JSON (`session/settled.go`, `session/background.go`). The compiler points at
the hand-written code that uses what changed.

Measured on 0.10.0 → 0.11.0: 928 types (from 832), 148 → 160 methods (the
14 `daemon.sf.*` gone with droid 1.4.1's Software Factory, 26 added, among
them `get_message_blocks`, `answer_elicitation`, `resolve_file_links`,
`send_session`/`import_session` and the shared folder's), 3 notifications
more, and `LoadSessionParams.TaskSubagentProcess` (with
`session.SpawnOptions.TaskSubagentProcess`) gone, as droid no longer has it.
`gen/` needed five fixes: 0.11 splits the SDK into chunks that import each
other (`expose.cjs` exposes the schemas of every chunk the main one imports),
`sendRequest(request, X)` calls (`methods.cjs`), result types that are not a
named struct (`[]json.RawMessage`), load's snapshot typed as
`RuntimeContentBlock` (a `ContentBlock` that may carry `isStreaming`; it
stays `Session` and `FactoryDroidMessage`, `sameAs` in `gen.mjs`), and
timeout overrides read from the bundle's constants, so `cleanup_worktree` waits
900 s as the TS client does (it was 180 s). The Fake Daemon still checks its
messages with 0.9.1's schemas.

Measured on 0.9.1 → 0.10.0: 171 types added (and droid 1.0's 5 in
`NEWER_TYPES`), 5 renamed or dropped (`EditableSkillSettingsLevel` is
`ConfigItemsParamsLevel` now), 132 → 148 methods (one of them droid 1.0's), 2 signatures changed (`GetDefaultSettings` and `RelayStart` take
params), and the spec handoff's hand-written decoding replaced by the
generated `SpecHandoffSessionCreatedNotification`. `gen/` needed three
fixes: 0.10's `engine.request(...)` calls, unions whose branch
discriminator is a `z.enum`, and requests the TS client does not call
(`get_git_branch_divergence`, `warmup_cache`, `desktop.status`), which
are methods now rather than requests of the Daemon.

Measured on 0.8.0 → 0.9.1: 11 types added or renamed, ~500 changed lines of
generated code, the same 132 methods, and 6 compile errors, all in `session`
where it uses what 0.9 added (message retraction, rich message content).
Regenerating takes about a minute; porting the new behaviour of a release is
hand work on the TS sources (split readable with `gen/split.cjs`), typically
hours, mostly in `session` and `controller`.
