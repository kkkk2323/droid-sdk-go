package session

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

func TestTodosFollowSuccessfulTodoWrites(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{Session: protocol.Session{Messages: []protocol.FactoryDroidMessage{msg("u1", roleUser, "plan", 1, "")}}})
	sess := s.Session(id)
	rec := record(s)
	todoWrite := func(toolUseID string, todos any) {
		send(t, s, id, map[string]any{"type": "tool_call", "toolUse": map[string]any{"type": "tool_use", "id": toolUseID, "name": "TodoWrite", "input": map[string]any{"todos": todos}}})
	}
	result := func(toolUseID string, isError bool) {
		send(t, s, id, map[string]any{"type": "tool_result", "toolUseId": toolUseID, "content": "TODO List Updated", "isError": isError, "messageId": "r-" + toolUseID})
	}

	todoWrite("t1", []map[string]any{
		{"id": "1", "content": "Read the code", "status": "completed", "priority": "medium"},
		{"id": "2", "content": "Fix it", "status": "in_progress", "priority": "medium"},
	})
	if sess.Todos() != nil {
		t.Fatal("todos before the result")
	}
	result("t1", false)
	if got := sess.Todos(); len(got) != 2 || got[1].Status != TodoInProgress || got[1].Priority != "medium" {
		t.Fatalf("todos %+v", got)
	}
	if !rec.has(Event{Kind: EventTodosUpdated, SessionID: id}) {
		t.Fatal("no todo event")
	}

	todoWrite("t2", "1. [completed] Nothing")
	result("t2", true)
	if got := sess.Todos(); len(got) != 2 {
		t.Fatalf("a failed TodoWrite must not change the list: %+v", got)
	}
	todoWrite("t3", []string{"[completed] Read the code", "[completed] Fix it", "[pending] Ship"})
	result("t3", false)
	result("t1", false) // replayed result of an older TodoWrite
	if got := sess.Todos(); len(got) != 3 || got[2].Content != "Ship" || got[0].Status != TodoCompleted {
		t.Fatalf("todos after t3 %+v", got)
	}

	// A load rebuilds the list from the transcript.
	loadWith(t, s, id, protocol.LoadSessionResult{})
	if got := sess.Todos(); len(got) != 3 {
		t.Fatalf("todos after reload %+v", got)
	}
}

func TestParseTodos(t *testing.T) {
	lines, _ := json.Marshal("1. [completed] Read\n- [ ] Fix\n* [x] Test\n\n2) Ship it\nplain")
	got := ParseTodos(lines)
	want := []TodoItem{
		{"1", "Read", TodoCompleted, "high"},
		{"2", "Fix", TodoPending, "high"},
		{"3", "Test", TodoCompleted, "high"},
		{"4", "Ship it", TodoPending, "high"},
		{"5", "plain", TodoPending, "high"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("item %d: got %+v want %+v", i, got[i], want[i])
		}
	}
	asString, _ := json.Marshal(`[{"content":"A","status":"pending"},{"content":"B","status":"bogus"},{"id":"x","content":"C","status":"completed","priority":"low"}]`)
	got = ParseTodos(asString)
	if len(got) != 2 || got[0].ID != "1" || got[1].ID != "x" || got[1].Priority != "low" {
		t.Fatalf("JSON string todos %+v", got)
	}
}

func queued(requestID, text string, kind QueuedMessageKind, at time.Time, extra ...protocol.ContentBlock) QueuedMessage {
	return QueuedMessage{RequestID: requestID, Content: append([]protocol.ContentBlock{textBlock(text)}, extra...), Kind: kind, CreatedAt: at}
}

func kindsOf(qs []QueuedMessage) map[string]QueuedMessageKind {
	out := map[string]QueuedMessageKind{}
	for _, q := range qs {
		out[q.RequestID] = q.Kind
	}
	return out
}

func TestQueuedMessagesLifecycle(t *testing.T) {
	s, clk := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	rec := record(s)
	image := blockOf(map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "AAAA", "mediaType": "image/png"}})
	now := clk.now()
	sess.QueueUserMessages(
		queued("r1", "steer", KindDaemonQueuedDiscardable, now),
		queued("r2", "later", KindDaemonQueuedEndOfLoop, now),
		queued("r3", "look", KindDaemonQueuedDiscardable, now, image),
		queued("r4", "retype me", KindDaemonQueuedDiscardable, now),
	)
	if len(sess.QueuedMessages()) != 4 || !rec.has(Event{Kind: EventQueuedMessagesUpdated, SessionID: id}) {
		t.Fatal("queue not filled")
	}

	send(t, s, id, created(msg("u1", roleUser, "steer", 5, ""), "r1"))
	sess.QueueUserMessages(queued("r1", "steer", KindDaemonQueuedDiscardable, now))
	if _, ok := sess.QueuedMessage("r1"); ok {
		t.Fatal("a delivered message must leave the queue and not come back")
	}

	send(t, s, id, map[string]any{"type": "queued_messages_discarded", "text": "Discarded 3 queued message(s)"})
	got := kindsOf(sess.QueuedMessages())
	if len(got) != 2 || got["r2"] != KindLocalPausedAfterEsc || got["r3"] != KindLocalPausedAfterEsc {
		t.Fatalf("after discard %v", got)
	}
}

func TestQueueReconciliationOnLoad(t *testing.T) {
	s, clk := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	now := clk.now()
	sess.QueueUserMessages(
		queued("l1", "paused", KindLocalPausedAfterEsc, now),
		queued("d1", "lost", KindDaemonQueuedDiscardable, now),
		queued("d2", "delivered", KindDaemonQueuedDiscardable, now),
		queued("d3", "held", KindDaemonQueuedEndOfLoop, now),
	)
	deliveredMsg := msg("u9", roleUser, "delivered", float64(now.UnixMilli()+10), "")
	res := protocol.LoadSessionResult{
		Session:        protocol.Session{Messages: []protocol.FactoryDroidMessage{deliveredMsg}},
		QueuedMessages: []protocol.LoadSessionResultQueuedMessagesItem{{RequestID: "d3", Text: "held", QueuePlacement: protocol.QueuePlacementEndOfLoop}},
	}
	out := loadWith(t, s, id, res)
	if len(out.Resubmit) != 1 || out.Resubmit[0].RequestID != "d1" {
		t.Fatalf("resubmit %+v", out.Resubmit)
	}
	if p := ResubmitParams(out.Resubmit[0]); p.Text != "lost" || p.QueuePlacement != protocol.QueuePlacementEndOfTurn || p.Content != nil {
		t.Fatalf("resubmit params %+v", p)
	}
	// The resent message stays queued until its create_message comes.
	qs := sess.QueuedMessages()
	if len(qs) != 3 || qs[0].RequestID != "l1" || qs[1].RequestID != "d3" || qs[1].Kind != KindDaemonQueuedEndOfLoop || textOf(protocol.FactoryDroidMessage{Content: qs[1].Content}) != "held" || qs[2].RequestID != "d1" {
		t.Fatalf("queue after load %+v", qs)
	}
	send(t, s, id, created(msg("u10", roleUser, "lost", float64(now.UnixMilli()+20), ""), "d1"))
	if _, ok := sess.QueuedMessage("d1"); ok {
		t.Fatal("the resent message stayed queued after its create_message")
	}

	// While the agent loop runs, a message the Daemon no longer lists may
	// still be draining: keep it.
	sess.QueueUserMessages(queued("d4", "draining", KindDaemonQueuedDiscardable, now))
	loop := true
	out = loadWith(t, s, id, protocol.LoadSessionResult{IsAgentLoopInProgress: &loop})
	if len(out.Resubmit) != 0 || out.ReportedWorkingState != protocol.DroidWorkingStateStreamingAssistantMessage {
		t.Fatalf("outcome %+v", out)
	}
	if got := kindsOf(sess.QueuedMessages()); got["d4"] != KindDaemonQueuedDiscardable {
		t.Fatalf("draining message dropped: %v", got)
	}
}

// A message queued when the connection dropped may have been taken or
// dropped by the Daemon meanwhile: the reload's pendingMessageRequestIds
// decide, and it is never sent again.
func TestQueueAfterATransportDrop(t *testing.T) {
	s, clk := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	now := clk.now()
	sess.QueueUserMessages(
		queued("took", "taken by the Daemon", KindDaemonQueuedDiscardable, now),
		queued("dropped", "dropped by the Daemon", KindDaemonQueuedDiscardable, now),
		queued("l1", "paused", KindLocalPausedAfterEsc, now),
	)
	s.MarkQueuesTransportInterrupted()
	if len(sess.QueuedMessages()) != 3 {
		t.Fatal("a dropped connection must keep the queue shown")
	}
	clk.add(time.Second)
	sess.QueueUserMessages(queued("after", "queued after the drop", KindDaemonQueuedDiscardable, clk.now()))
	out := loadWith(t, s, id, protocol.LoadSessionResult{
		PendingMessageRequestIDs: []string{"took"},
		QueuedMessages: []protocol.LoadSessionResultQueuedMessagesItem{
			{RequestID: "peer", Text: "a peer Session's", Sender: &protocol.MessageSender{}},
		},
	})
	if len(out.Resubmit) != 1 || out.Resubmit[0].RequestID != "after" {
		t.Fatalf("resubmit %+v", out.Resubmit)
	}
	got := kindsOf(sess.QueuedMessages())
	if len(got) != 3 || got["took"] != KindDaemonQueuedDiscardable || got["after"] != KindDaemonQueuedDiscardable || got["l1"] != KindLocalPausedAfterEsc {
		t.Fatalf("queue after the reload %v", got)
	}

	// That load settled the drop: what is left is like any queued message.
	out = loadWith(t, s, id, protocol.LoadSessionResult{PendingMessageRequestIDs: []string{"took"}})
	if len(out.Resubmit) != 1 || out.Resubmit[0].RequestID != "after" {
		t.Fatalf("resubmit after the drop settled %+v", out.Resubmit)
	}
}

// A Daemon older than pendingMessageRequestIds cannot say it took a message
// queued when the connection dropped: it goes, unsent, even while the loop
// runs.
func TestQueueAfterATransportDropOnAnOlderDaemon(t *testing.T) {
	s, clk := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	sess.QueueUserMessages(queued("q1", "interrupted", KindDaemonQueuedDiscardable, clk.now()))
	s.MarkQueuesTransportInterrupted(id)
	loop := true
	out := loadWith(t, s, id, protocol.LoadSessionResult{IsAgentLoopInProgress: &loop})
	if len(out.Resubmit) != 0 || len(sess.QueuedMessages()) != 0 {
		t.Fatalf("resubmit %+v, queue %+v", out.Resubmit, sess.QueuedMessages())
	}
	// Re-queued by the user after the drop, it is a fresh message.
	sess.QueueUserMessages(queued("q1", "interrupted", KindDaemonQueuedDiscardable, clk.now()))
	if out := loadWith(t, s, id, protocol.LoadSessionResult{}); len(out.Resubmit) != 1 {
		t.Fatalf("resubmit %+v", out.Resubmit)
	}
}

// A drop after the result arrived is newer than what the result says: the
// result treats the queue as before the drop, and the drop's mark, made
// again once the result is applied, waits for the next load.
func TestALoadResultPinsTheDropsItAnswers(t *testing.T) {
	s, clk := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	sess.QueueUserMessages(queued("q1", "lost", KindDaemonQueuedDiscardable, clk.now()))
	tok := s.AtLoadResult(s.BeginLoad(id))
	s.MarkQueuesTransportInterrupted()
	out := s.ApplyLoadResult(tok, &protocol.LoadSessionResult{PendingMessageRequestIDs: []string{}}, 0)
	if len(out.Resubmit) != 1 || out.Resubmit[0].RequestID != "q1" {
		t.Fatalf("resubmit %+v", out.Resubmit)
	}
	s.MarkQueuesTransportInterrupted(id)
	if out := loadWith(t, s, id, protocol.LoadSessionResult{PendingMessageRequestIDs: []string{}}); len(out.Resubmit) != 0 || len(sess.QueuedMessages()) != 0 {
		t.Fatalf("after the newer drop: resubmit %+v, queue %+v", out.Resubmit, sess.QueuedMessages())
	}
}

func withSeq(m protocol.FactoryDroidMessage, seq int64) protocol.FactoryDroidMessage {
	m.Seq = &seq
	return m
}

// Messages the Daemon stamped with a seq are in seq order, whenever they
// arrive; rows without one keep their place.
func TestMessagesFollowSeq(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{Session: protocol.Session{Messages: []protocol.FactoryDroidMessage{
		withSeq(msg("a1", roleAssistant, "hi", 20, "u1"), 1),
		withSeq(msg("u1", roleUser, "hello", 10, ""), 0),
	}}})
	sess := s.Session(id)
	if got := idsOf(sess.Messages()); got != "u1,a1" {
		t.Fatalf("loaded %s", got)
	}
	send(t, s, id, created(withSeq(msg("a3", roleAssistant, "late", 40, ""), 3), ""))
	send(t, s, id, created(withSeq(msg("u2", roleUser, "again", 30, ""), 2), ""))
	if got := idsOf(sess.Messages()); got != "u1,a1,u2,a3" {
		t.Fatalf("out of order %s", got)
	}
	// Unconfirmed, x keeps its arrival place; confirmed, it moves to its seq.
	send(t, s, id, created(msg("x", roleUser, "unconfirmed", 50, ""), ""))
	send(t, s, id, created(withSeq(msg("y", roleAssistant, "y", 60, ""), 4), ""))
	send(t, s, id, created(withSeq(msg("z", roleAssistant, "z", 70, ""), 5), ""))
	if got := idsOf(sess.Messages()); got != "u1,a1,u2,a3,x,y,z" {
		t.Fatalf("before the confirmation %s", got)
	}
	send(t, s, id, created(withSeq(msg("x", roleUser, "unconfirmed", 50, ""), 6), ""))
	if got := idsOf(sess.Messages()); got != "u1,a1,u2,a3,y,z,x" {
		t.Fatalf("after the confirmation %s", got)
	}
}

// Rows without a seq are floors a stamped row does not pass, unless a larger
// seq sits before the floor: then the thread is sorted, the row without one
// keeping its place after the row before it.
func TestSeqLessRowsAreFloors(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{Session: protocol.Session{Messages: []protocol.FactoryDroidMessage{
		msg("h1", roleUser, "legacy", 10, ""),
		msg("h2", roleAssistant, "legacy", 20, "h1"),
	}}})
	sess := s.Session(id)
	send(t, s, id, created(withSeq(msg("n1", roleUser, "new", 5, ""), 7), ""))
	if got := idsOf(sess.Messages()); got != "h1,h2,n1" {
		t.Fatalf("after the floor %s", got)
	}
	send(t, s, id, created(msg("f", roleUser, "floor", 30, ""), ""))
	send(t, s, id, created(withSeq(msg("n0", roleUser, "earlier", 40, ""), 3), ""))
	// Effective seqs: h1 0, h2 1, n1 7, f 8, n0 3.
	if got := idsOf(sess.Messages()); got != "h1,h2,n0,n1,f" {
		t.Fatalf("sorted %s", got)
	}
}

func backgroundProcess(id string, pid float64) protocol.SessionBackgroundProcess {
	return protocol.SessionBackgroundProcess{ID: id, Pid: pid, Command: "npm run dev", StartedAtMs: 1, ToolUseID: id, OutputFile: "/tmp/" + id + ".log"}
}

func backgroundChanged(capturedAtMs float64, procs ...protocol.SessionBackgroundProcess) map[string]any {
	if procs == nil {
		procs = []protocol.SessionBackgroundProcess{}
	}
	return map[string]any{"type": "background_processes_changed", "capturedAtMs": capturedAtMs, "processes": procs}
}

func TestBackgroundProcesses(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	// One for a Session not registered yet waits for it.
	send(t, s, id, backgroundChanged(5, backgroundProcess("tu0", 40)))
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	if got := sess.BackgroundProcesses(); len(got) != 1 || got[0].ID != "tu0" {
		t.Fatalf("replayed %+v", got)
	}
	rec := record(s)
	send(t, s, id, backgroundChanged(10, backgroundProcess("tu1", 41), backgroundProcess("tu2", 42)))
	got := sess.BackgroundProcesses()
	if len(got) != 2 || got[1].Pid != 42 || got[1].OutputFile != "/tmp/tu2.log" || !rec.has(Event{Kind: EventMetadataUpdated, SessionID: id}) {
		t.Fatalf("processes %+v", got)
	}
	got[0].ID = "changed"
	if sess.BackgroundProcesses()[0].ID != "tu1" {
		t.Fatal("BackgroundProcesses must return a copy")
	}
	// An older snapshot, delivered late, does not undo a newer one.
	send(t, s, id, backgroundChanged(8, backgroundProcess("tu1", 41)))
	if len(sess.BackgroundProcesses()) != 2 {
		t.Fatal("an older snapshot replaced a newer one")
	}
	send(t, s, id, backgroundChanged(12, backgroundProcess("tu2", 42)))
	if got := sess.BackgroundProcesses(); len(got) != 1 || got[0].ID != "tu2" {
		t.Fatalf("after one ended %+v", got)
	}

	// A load brings the Daemon's list, unless one came while it was out.
	tok := s.BeginLoad(id)
	s.ApplyLoadResult(tok, &protocol.LoadSessionResult{BackgroundProcesses: &protocol.SessionBackgroundProcessesSnapshot{CapturedAtMs: 20, Processes: []protocol.SessionBackgroundProcess{backgroundProcess("tu3", 43)}}}, 0)
	if got := sess.BackgroundProcesses(); len(got) != 1 || got[0].ID != "tu3" {
		t.Fatalf("after a load %+v", got)
	}
	tok = s.BeginLoad(id)
	send(t, s, id, backgroundChanged(30))
	s.ApplyLoadResult(tok, &protocol.LoadSessionResult{BackgroundProcesses: &protocol.SessionBackgroundProcessesSnapshot{CapturedAtMs: 25, Processes: []protocol.SessionBackgroundProcess{backgroundProcess("tu3", 43)}}}, 0)
	if got := sess.BackgroundProcesses(); got != nil {
		t.Fatalf("a load's older list replaced a live one: %+v", got)
	}

	// The worker kills them as it exits.
	send(t, s, id, backgroundChanged(40, backgroundProcess("tu4", 44)))
	send(t, s, id, map[string]any{"type": "session_process_exited", "message": "exited", "timestamp": 1})
	if got := sess.BackgroundProcesses(); got != nil {
		t.Fatalf("after the worker exited %+v", got)
	}
}

func TestLoadThenPrependOlderPage(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	older := true
	loadWith(t, s, id, protocol.LoadSessionResult{
		Session: protocol.Session{Messages: []protocol.FactoryDroidMessage{
			msg("u2", roleUser, "second", 30, "a1"),
			msg("a2", roleAssistant, "answer 2", 40, "u2"),
		}},
		HasOlderMessages: &older,
		AvailableModels:  []protocol.ModelMetadata{{ID: "m"}},
		Cwd:              "/repo",
	})
	sess := s.Session(id)
	cursor, ok := sess.OlderMessagesCursor()
	if !ok || cursor != "u2" {
		t.Fatalf("cursor %q %v", cursor, ok)
	}
	s.PrependOlderMessages(id, []protocol.FactoryDroidMessage{
		msg("u1", roleUser, "first", 10, ""),
		msg("a1", roleAssistant, "answer 1", 20, "u1"),
	}, false)
	if got := idsOf(sess.Messages()); got != "u1,a1,u2,a2" {
		t.Fatalf("order %s", got)
	}
	if sess.HasOlderMessages() || len(sess.AvailableModels()) != 1 || sess.Cwd() != "/repo" || sess.LoadState() != Loaded {
		t.Fatalf("older=%v models=%d cwd=%q load=%s", sess.HasOlderMessages(), len(sess.AvailableModels()), sess.Cwd(), sess.LoadState())
	}
	if _, ok := sess.OlderMessagesCursor(); ok {
		t.Fatal("no cursor once everything is loaded")
	}
}

// A Session the Store forgot still gets the Daemon's notices; one saying
// its worker stopped is older than a later load, which must not end
// NotLoaded because of it.
func TestALoadOutdatesAnEarlierInactivity(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	send(t, s, id, map[string]any{"type": "session_inactivity", "message": "idle", "timestamp": 1, "timeoutSeconds": 1800})
	send(t, s, id, map[string]any{"type": "session_title_updated", "title": "Early"})
	loadWith(t, s, id, protocol.LoadSessionResult{})
	sess := s.Session(id)
	if sess.LoadState() != Loaded || s.IsInactive(id) {
		t.Fatalf("after the load: %s, inactive %v", sess.LoadState(), s.IsInactive(id))
	}
	if sess.Title() != "Early" {
		t.Fatalf("the other notice was dropped too: title %q", sess.Title())
	}
}

func TestLoadStateTransitions(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	rec := record(s)
	// A notification for an unknown Session waits for its load.
	send(t, s, id, map[string]any{"type": "session_title_updated", "title": "Early"})
	if s.Session(id) != nil {
		t.Fatal("a notification must not register a Session")
	}
	tok := s.BeginLoad(id)
	if s.LoadState(id) != Loading || !rec.has(Event{Kind: EventLoadStateChanged, SessionID: id, LoadState: Loading}) {
		t.Fatalf("state %s", s.LoadState(id))
	}
	// A live working-state notification during the call wins over the
	// result's.
	send(t, s, id, working("executing_tool"))
	idle := protocol.DroidWorkingStateIdle
	s.ApplyLoadResult(tok, &protocol.LoadSessionResult{WorkingState: idle}, 50)
	sess := s.Session(id)
	if sess.LoadState() != Loaded || sess.Title() != "Early" || sess.LoadedMessageLimit() != 50 {
		t.Fatalf("load %s title %q limit %d", sess.LoadState(), sess.Title(), sess.LoadedMessageLimit())
	}
	if sess.WorkingState() != protocol.DroidWorkingStateExecutingTool || s.ApplyLoadedWorkingState(tok, idle) {
		t.Fatalf("stale load working state applied: %s", sess.WorkingState())
	}

	s.MarkLoading(id)
	if sess.LoadState() != Loaded {
		t.Fatal("MarkLoading must not demote a Loaded Session")
	}
	send(t, s, id, map[string]any{"type": "session_inactivity", "message": "idle", "timestamp": 1, "timeoutSeconds": 60})
	if sess.LoadState() != NotLoaded || !s.IsInactive(id) || sess.WorkingState() != idle {
		t.Fatalf("inactive: load %s inactive %v working %s", sess.LoadState(), s.IsInactive(id), sess.WorkingState())
	}

	tok = s.BeginLoad(id)
	s.ApplyLoadResult(tok, &protocol.LoadSessionResult{WorkingState: protocol.DroidWorkingStateWaitingForToolConfirmation}, 0)
	if sess.WorkingState() != protocol.DroidWorkingStateWaitingForToolConfirmation {
		t.Fatalf("hydrated working state %s", sess.WorkingState())
	}
	s.MarkAllNotLoaded()
	if sess.LoadState() != NotLoaded || sess.WorkingState() != idle {
		t.Fatalf("after disconnect %s %s", sess.LoadState(), sess.WorkingState())
	}

	rec.reset()
	send(t, s, id, map[string]any{"type": "session_closed", "timestamp": 2})
	if s.Session(id) != nil || !rec.has(Event{Kind: EventRemoved, SessionID: id}) {
		t.Fatal("session_closed should remove the Session")
	}
	s.MarkNotFound("gone")
	if !s.IsNotFound("gone") || s.LoadState("gone") != NotLoaded {
		t.Fatal("not found")
	}
}

func TestFilterMessagesForUI(t *testing.T) {
	hidden := true
	hook := protocol.FactoryDroidMessage{ID: "h", Role: roleSystem, HookEventName: "PreToolUse", HookCommands: []protocol.PersistedHookCommand{}, HookStatus: "completed"}
	llmOnly := msg("l", roleSystem, "for the model", 1, "")
	llmOnly.Visibility = protocol.MessageVisibilityLLMOnly
	hiddenMsg := msg("x", roleAssistant, "secret", 1, "")
	hiddenMsg.HiddenFromUserViews = &hidden
	in := []protocol.FactoryDroidMessage{
		msg("u1", roleUser, "<system-reminder>ctx</system-reminder>\nHi there", 1, ""),
		msg("u2", roleUser, "<system-notification>only</system-notification>", 2, ""),
		llmOnly, hiddenMsg,
		msg("a1", roleAssistant, "<system-reminder>kept</system-reminder>", 3, ""),
		hook,
	}
	out := FilterMessagesForUI(in)
	if got := idsOf(out); got != "u1,a1,h" {
		t.Fatalf("kept %s", got)
	}
	if textOf(out[0]) != "Hi there" || textOf(out[1]) != "<system-reminder>kept</system-reminder>" {
		t.Fatalf("texts %q %q", textOf(out[0]), textOf(out[1]))
	}
	if textOf(in[0]) == "Hi there" {
		t.Fatal("input modified")
	}
}

func TestOptimisticSubmitConfirmCancelTimeout(t *testing.T) {
	s, _ := newTestStore()
	const id = "s1"
	loadWith(t, s, id, protocol.LoadSessionResult{Session: protocol.Session{Messages: []protocol.FactoryDroidMessage{msg("u0", roleUser, "old", 1, "")}}})
	sess := s.Session(id)
	confirmed := make(chan struct{}, 1)
	s.RegisterOptimisticSubmit(OptimisticSubmit{
		SessionID: id, ExternalKey: "k1", UserMessage: msg("um1", roleUser, "hello", 100, ""),
		AssistantBubbleID: "b1", OnConfirm: func() { confirmed <- struct{}{} },
	})
	if got := idsOf(sess.DisplayMessages()); got != "u0,um1" || sess.AssistantBubbleID() != "b1" {
		t.Fatalf("display %s bubble %q", got, sess.AssistantBubbleID())
	}
	send(t, s, id, created(msg("um1", roleUser, "hello", 101, ""), "k1"))
	select {
	case <-confirmed:
	default:
		t.Fatal("OnConfirm not called")
	}
	if got := idsOf(sess.DisplayMessages()); got != "u0,um1" || sess.AssistantBubbleID() != "" || s.HasPendingOptimisticSubmit(id) {
		t.Fatalf("after confirm %s bubble %q", got, sess.AssistantBubbleID())
	}

	failed := make(chan error, 1)
	s.RegisterOptimisticSubmit(OptimisticSubmit{
		SessionID: id, ExternalKey: "k2", UserMessage: msg("um2", roleUser, "slow", 200, ""),
		AssistantBubbleID: "b2", OnError: func(err error) { failed <- err }, ErrorTimeout: 10 * time.Millisecond,
	})
	select {
	case err := <-failed:
		if !errors.Is(err, ErrSubmitTimeout) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no timeout")
	}
	if !s.CancelOptimisticSubmit("k2") || idsOf(sess.DisplayMessages()) != "u0,um1" {
		t.Fatalf("cancel left %s", idsOf(sess.DisplayMessages()))
	}

	// A create_message lost on the wire: the next load confirms by text.
	s.RegisterOptimisticSubmit(OptimisticSubmit{SessionID: id, ExternalKey: "k3", UserMessage: msg("tmp", roleUser, "again", 300, ""), AssistantBubbleID: "b3"})
	loadWith(t, s, id, protocol.LoadSessionResult{Session: protocol.Session{Messages: []protocol.FactoryDroidMessage{msg("real", roleUser, "again", 301, "um1")}}})
	if s.HasPendingOptimisticSubmit(id) || idsOf(sess.DisplayMessages()) != "u0,um1,real" {
		t.Fatalf("reconcile left %s", idsOf(sess.DisplayMessages()))
	}
}

func TestChildSessionAvailableAndSubagentSummary(t *testing.T) {
	s, _ := newTestStore()
	const parent, child = "p", "c"
	loadWith(t, s, parent, protocol.LoadSessionResult{Cwd: "/repo"})
	// The child's first notification beats child_session_available.
	send(t, s, child, created(protocol.FactoryDroidMessage{
		ID: "ca1", Role: roleAssistant, Content: []protocol.ContentBlock{toolUseBlock("x1", "Read", map[string]any{})}, CreatedAt: 10, UpdatedAt: 10,
	}, ""))
	send(t, s, parent, map[string]any{
		"type": "child_session_available", "childSessionId": child, "toolUseId": "task1",
		"subagentType": "worker", "description": "Read the code", "timestamp": 1,
	})
	c := s.Session(child)
	if c == nil {
		t.Fatal("child not registered")
	}
	if ps, tool := c.CallingSession(); ps != parent || tool != "task1" || c.Cwd() != "/repo" || c.MessageCount() != 1 {
		t.Fatalf("child %s %s cwd %q messages %d", ps, tool, c.Cwd(), c.MessageCount())
	}
	if c.WorkingState() != protocol.DroidWorkingStateStreamingAssistantMessage {
		t.Fatalf("child working %s", c.WorkingState())
	}
	if m := s.SubagentSessionIDsByParent(); m[parent]["task1"] != child {
		t.Fatalf("by parent %v", m)
	}
	if got, ok := s.FindSubagentSessionID(parent, "task1"); !ok || got != child {
		t.Fatal("FindSubagentSessionID")
	}
	sum, ok := s.SubagentInvocationSummary(child)
	if !ok || sum.Status != protocol.TaskInvocationStatusRunning || sum.SubagentType != "worker" {
		t.Fatalf("summary %+v", sum)
	}
	send(t, s, child, map[string]any{"type": "agent_turn_completed", "reason": "completed", "tokenUsage": zeroUsage})
	sum, _ = s.SubagentInvocationSummary(child)
	if sum.Status != protocol.TaskInvocationStatusCompleted || sum.ToolUseCount == nil || *sum.ToolUseCount != 1 {
		t.Fatalf("settled summary %+v", sum)
	}
}

func TestChildSessionSettledEndsASubagentFromItsParent(t *testing.T) {
	s, _ := newTestStore()
	const parent, child = "p", "c"
	loadWith(t, s, parent, protocol.LoadSessionResult{Cwd: "/repo"})
	send(t, s, parent, map[string]any{
		"type": "child_session_available", "childSessionId": child, "toolUseId": "task2",
		"subagentType": "worker", "description": "Run the tests", "timestamp": 1,
	})
	c := s.Session(child)
	if c == nil || c.WorkingState() == protocol.DroidWorkingStateIdle {
		t.Fatal("child not shown working")
	}
	rev := c.WorkingStateRevision()
	// An earlier Task of the same child settles: not this run's end.
	send(t, s, parent, map[string]any{"type": "child_session_settled", "childSessionId": child, "toolUseId": "task1", "status": "completed", "timestamp": 2})
	if c.WorkingState() == protocol.DroidWorkingStateIdle {
		t.Fatal("a settle for an earlier Task stopped the child")
	}
	// The child runs on another computer: only its parent says it ended.
	send(t, s, parent, map[string]any{"type": "child_session_settled", "childSessionId": child, "toolUseId": "task2", "status": "cancelled", "timestamp": 3})
	if c.WorkingState() != protocol.DroidWorkingStateIdle || c.WorkingStateRevision() == rev {
		t.Fatalf("child %s, revision %d", c.WorkingState(), c.WorkingStateRevision())
	}
	if sum, _ := s.SubagentInvocationSummary(child); sum.Status != protocol.TaskInvocationStatusCancelled {
		t.Fatalf("summary %+v", sum)
	}
	// A status this reader does not know is a failure, not a success.
	send(t, s, parent, map[string]any{"type": "child_session_settled", "childSessionId": child, "toolUseId": "task2", "status": "archived", "timestamp": 4})
	if sum, _ := s.SubagentInvocationSummary(child); sum.Status != protocol.TaskInvocationStatusFailed {
		t.Fatalf("unknown status read as %s", sum.Status)
	}
}

func TestRepairParentChain(t *testing.T) {
	out := repairParentChain([]protocol.FactoryDroidMessage{
		msg("a", roleUser, "", 1, "c"),
		msg("b", roleAssistant, "", 2, "a"),
		msg("c", roleUser, "", 3, "b"),
		msg("d", roleUser, "", 4, "d"),
	})
	if out[0].ParentID != "" || out[1].ParentID != "a" || out[2].ParentID != "b" || out[3].ParentID != "" {
		t.Fatalf("repaired %+v", out)
	}
}
