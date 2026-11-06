package controller_test

import (
	"context"
	"testing"
	"time"

	"github.com/kkkk2323/droid-sdk-go/controller"
	"github.com/kkkk2323/droid-sdk-go/fakedaemon"
	"github.com/kkkk2323/droid-sdk-go/protocol"
)

// daemon.get_session_turn_outcome (droid 1.4.1) reads a turn's outcome from
// the Session's transcript, once: a turn that ended is there with its last
// reply, after a Daemon restart too; a turn still running or never run is
// unverified; a Session without a transcript is not found.
func TestTurnOutcomes(t *testing.T) {
	d := fakedaemon.Start(t, fakedaemon.Scenario{
		Sessions: []fakedaemon.SessionSpec{{Title: "Chat", Cwd: "/Users/dev/acme-web"}},
		Turn:     &fakedaemon.Turn{Kind: "permission", Command: "npm test", Reply: "All tests pass."},
	})
	c, r := start(t, d, controller.Config{ReconnectDelay: 200 * time.Millisecond, MaxReconnectAttempts: 10})
	ctx := context.Background()
	id := d.Sessions[0].SessionID
	if _, err := c.LoadSession(ctx, protocol.LoadSessionParams{SessionID: id}); err != nil {
		t.Fatal(err)
	}
	outcome := func(sessionID, turnID string) any {
		t.Helper()
		cl, err := c.Client()
		if err != nil {
			t.Fatal(err)
		}
		res, err := cl.GetSessionTurnOutcome(ctx, protocol.GetSessionTurnOutcomeParams{SessionID: sessionID, TurnID: turnID, TimeoutMs: 1000})
		if err != nil {
			t.Fatal(err)
		}
		v, err := res.Value()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	unavailable := func(sessionID, turnID string, reason protocol.DaemonGetSessionTurnOutcomeUnavailableReason) {
		t.Helper()
		got, ok := outcome(sessionID, turnID).(*protocol.DaemonGetSessionTurnOutcomeResultUnavailable)
		if !ok || got.SessionID != sessionID || got.TurnID != turnID || got.Reason != reason {
			t.Fatalf("outcome of %s in %s: %+v, want %s", turnID, sessionID, got, reason)
		}
	}
	available := func(turnID string, reason protocol.AgentTurnCompletionReason, final string) {
		t.Helper()
		got, ok := outcome(id, turnID).(*protocol.DaemonGetSessionTurnOutcomeResultAvailable)
		if !ok {
			t.Fatalf("outcome of %s: %+v", turnID, got)
		}
		v, err := got.Outcome.Value()
		text, isText := v.(*protocol.AgentTurnOutcomeText)
		if err != nil || !isText || got.SessionID != id || got.TurnID != turnID || text.TurnID != turnID ||
			text.Type != "agent_turn_outcome" || text.Reason != reason || got.FinalOutput != final {
			t.Fatalf("outcome of %s: %+v (%+v, %v), want %s %q", turnID, got, v, err, reason, final)
		}
	}
	ask := func(from int, messageID string, answer protocol.ToolConfirmationOutcome) int {
		t.Helper()
		if _, err := c.AddUserMessage(ctx, protocol.AddUserMessageParams{SessionID: id, MessageID: messageID, Text: "Run the tests"}); err != nil {
			t.Fatal(err)
		}
		e, next := r.wait(t, from, "permission requested", func(e controller.Event) bool { _, ok := e.(controller.PermissionRequested); return ok })
		unavailable(id, messageID, protocol.DaemonGetSessionTurnOutcomeUnavailableReasonTurnUnverified)
		if err := c.RespondToPermission(ctx, e.(controller.PermissionRequested).Permission.RequestID, controller.PermissionAnswer{SelectedOption: answer}); err != nil {
			t.Fatal(err)
		}
		_, next = r.wait(t, next, "turn end", turnEnded)
		return next
	}

	next := ask(0, "turn-1", protocol.ToolConfirmationOutcomeCancel)
	available("turn-1", protocol.AgentTurnCompletionReasonPermissionRejected, "Understood, I will not run that.")
	next = ask(next, "turn-2", protocol.ToolConfirmationOutcomeProceedOnce)
	available("turn-2", protocol.AgentTurnCompletionReasonCompleted, "All tests pass.")
	available("turn-1", protocol.AgentTurnCompletionReasonPermissionRejected, "Understood, I will not run that.")
	unavailable(id, "never-sent", protocol.DaemonGetSessionTurnOutcomeUnavailableReasonTurnUnverified)
	unavailable("no-such-session", "turn-2", protocol.DaemonGetSessionTurnOutcomeUnavailableReasonSessionNotFound)

	// A turn a test makes up with notifications is in the transcript too.
	for _, n := range []map[string]any{
		{"type": "create_message", "message": map[string]any{"id": "made-up", "role": "user", "content": []map[string]any{{"type": "text", "text": "Ship it"}}, "createdAt": 1, "updatedAt": 1}},
		{"type": "create_message", "message": map[string]any{"id": "reply", "role": "assistant", "content": []map[string]any{{"type": "text", "text": "Shipped."}}, "createdAt": 2, "updatedAt": 2}},
		{"type": "agent_turn_completed", "reason": "completed", "turnId": "made-up", "tokenUsage": map[string]any{"inputTokens": 0, "outputTokens": 0, "cacheCreationTokens": 0, "cacheReadTokens": 0, "thinkingTokens": 0}},
	} {
		if err := d.Notify(id, n); err != nil {
			t.Fatal(err)
		}
	}
	_, next = r.wait(t, next, "the made-up turn's end", turnEnded)
	available("made-up", protocol.AgentTurnCompletionReasonCompleted, "Shipped.")

	if err := d.GoDown(); err != nil {
		t.Fatal(err)
	}
	_, next = r.wait(t, next, "reconnecting", func(e controller.Event) bool {
		s, ok := e.(controller.StatusChanged)
		return ok && s.Status.Reconnecting && !s.Status.Connected
	})
	if err := d.ComeBack(); err != nil {
		t.Fatal(err)
	}
	r.wait(t, next, "session loaded again", func(e controller.Event) bool {
		l, ok := e.(controller.SessionLoaded)
		return ok && l.SessionID == id
	})
	available("turn-2", protocol.AgentTurnCompletionReasonCompleted, "All tests pass.")
}
