package controller_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/kkkk2323/droid-sdk-go/controller"
	"github.com/kkkk2323/droid-sdk-go/fakedaemon"
	"github.com/kkkk2323/droid-sdk-go/protocol"
)

const specPlan = "1. Create hello.txt\n2. Read it back"

func specScenario() fakedaemon.Scenario {
	return fakedaemon.Scenario{
		Sessions: []fakedaemon.SessionSpec{{
			Title: "Plan", Cwd: "/Users/dev/acme-web",
			Extra: map[string]any{"settings": map[string]any{"interactionMode": "spec"}},
		}},
		Turn: &fakedaemon.Turn{Kind: "spec", Plan: specPlan, Title: "Add hello.txt", Reply: "Created hello.txt."},
	}
}

// askForSpec sends a message to a Session in Spec mode and returns the
// ExitSpecMode permission it gets.
func askForSpec(t *testing.T, c *controller.Controller, r *recorder, id string) (controller.Permission, int) {
	t.Helper()
	ctx := context.Background()
	if _, err := c.LoadSession(ctx, protocol.LoadSessionParams{SessionID: id}); err != nil {
		t.Fatal(err)
	}
	if mode := c.Store().Session(id).Settings().InteractionMode; mode != protocol.DroidInteractionModeSpec {
		t.Fatalf("loaded in mode %q", mode)
	}
	if _, err := c.AddUserMessage(ctx, protocol.AddUserMessageParams{SessionID: id, Text: "Plan hello.txt"}); err != nil {
		t.Fatal(err)
	}
	e, next := r.wait(t, 0, "permission requested", func(e controller.Event) bool { _, ok := e.(controller.PermissionRequested); return ok })
	p := e.(controller.PermissionRequested).Permission
	if len(p.ToolUses) != 1 || p.ToolUses[0].ToolUse.Name != "ExitSpecMode" || p.ToolUses[0].ConfirmationType != protocol.ToolConfirmationTypeExitSpecMode {
		t.Fatalf("permission: %+v", p)
	}
	var options []string
	for _, o := range p.Options {
		options = append(options, string(o.Value))
	}
	if got := strings.Join(options, ","); got != "proceed_once,proceed_auto_run_low,proceed_auto_run_medium,proceed_auto_run_high,proceed_new_session,proceed_new_session_low,proceed_new_session_medium,proceed_new_session_high,cancel" {
		t.Fatalf("options %s", got)
	}
	return p, next
}

type specResult struct {
	isError     bool
	text        string
	Approved    bool   `json:"approved"`
	Message     string `json:"message"`
	UserComment string `json:"userComment"`
}

// toolResult waits for the result of a tool use.
func toolResult(t *testing.T, r *recorder, from int, toolUseID string) specResult {
	t.Helper()
	e, _ := r.wait(t, from, "tool result", func(e controller.Event) bool {
		n, ok := e.(controller.SessionNotification)
		if !ok {
			return false
		}
		res, ok := n.Value.(*protocol.ToolResultNotification)
		return ok && res.ToolUseID == toolUseID
	})
	n := e.(controller.SessionNotification).Value.(*protocol.ToolResultNotification)
	var out specResult
	if err := json.Unmarshal(n.Content, &out.text); err != nil {
		t.Fatal(err)
	}
	out.isError = n.IsError != nil && *n.IsError
	if !out.isError {
		if err := json.Unmarshal([]byte(out.text), &out); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func turnEndedIn(sessionID string) func(controller.Event) bool {
	return func(e controller.Event) bool {
		n, ok := e.(controller.SessionNotification)
		return ok && n.SessionID == sessionID && turnEnded(e)
	}
}

func completion(e controller.Event) protocol.AgentTurnCompletionReason {
	return e.(controller.SessionNotification).Value.(*protocol.AgentTurnCompletedNotification).Reason
}

func textOf(m protocol.FactoryDroidMessage) string {
	var b strings.Builder
	for _, c := range m.Content {
		var tb protocol.TextBlock
		if c.Type == "text" && json.Unmarshal(c.Raw, &tb) == nil {
			b.WriteString(tb.Text)
		}
	}
	return b.String()
}

func TestSpecApprovedWithAutonomy(t *testing.T) {
	d := fakedaemon.Start(t, specScenario())
	c, r := start(t, d, controller.Config{})
	id := d.Sessions[0].SessionID
	p, next := askForSpec(t, c, r, id)
	if err := c.RespondToPermission(context.Background(), p.RequestID, controller.PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedAutoRunLow}); err != nil {
		t.Fatal(err)
	}
	res := toolResult(t, r, next, p.ToolUses[0].ToolUse.ID)
	if res.isError || !res.Approved || res.Message != "Spec mode exited. The user approved the plan. Continue with the implementation." {
		t.Fatalf("tool result %+v", res)
	}
	if e, _ := r.wait(t, next, "turn end", turnEnded); completion(e) != protocol.AgentTurnCompletionReasonCompleted {
		t.Fatalf("turn ended %s", completion(e))
	}
	if set := c.Store().Session(id).Settings(); set.InteractionMode != protocol.DroidInteractionModeAuto || set.AutonomyLevel != protocol.AutonomyLevelLow {
		t.Fatalf("settings %s/%s", set.InteractionMode, set.AutonomyLevel)
	}
	if got := streamedText(r); got != "Created hello.txt." {
		t.Fatalf("streamed %q", got)
	}
}

func TestSpecApprovedWithAComment(t *testing.T) {
	d := fakedaemon.Start(t, specScenario())
	c, r := start(t, d, controller.Config{})
	id := d.Sessions[0].SessionID
	p, next := askForSpec(t, c, r, id)
	if err := c.RespondToPermission(context.Background(), p.RequestID, controller.PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedOnce, Comment: "Add a trailing newline."}); err != nil {
		t.Fatal(err)
	}
	res := toolResult(t, r, next, p.ToolUses[0].ToolUse.ID)
	if !res.Approved || res.UserComment != "Add a trailing newline." || !strings.HasSuffix(res.Message, "\n\nUser comment: Add a trailing newline.") {
		t.Fatalf("tool result %+v", res)
	}
	r.wait(t, next, "turn end", turnEnded)
	if set := c.Store().Session(id).Settings(); set.InteractionMode != protocol.DroidInteractionModeAuto || set.AutonomyLevel != protocol.AutonomyLevelOff {
		t.Fatalf("settings %s/%s", set.InteractionMode, set.AutonomyLevel)
	}
}

func TestSpecCancelledStaysInSpecMode(t *testing.T) {
	d := fakedaemon.Start(t, specScenario())
	c, r := start(t, d, controller.Config{})
	id := d.Sessions[0].SessionID
	p, next := askForSpec(t, c, r, id)
	if err := c.RespondToPermission(context.Background(), p.RequestID, controller.PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeCancel, Comment: "Name it greeting.txt."}); err != nil {
		t.Fatal(err)
	}
	res := toolResult(t, r, next, p.ToolUses[0].ToolUse.ID)
	if !res.isError || res.text != "Error: Plan not approved - remaining in Spec Mode. Provide feedback to refine the spec." {
		t.Fatalf("tool result %+v", res)
	}
	if e, _ := r.wait(t, next, "turn end", turnEnded); completion(e) != protocol.AgentTurnCompletionReasonCompleted {
		t.Fatalf("turn ended %s", completion(e))
	}
	if mode := c.Store().Session(id).Settings().InteractionMode; mode != protocol.DroidInteractionModeSpec {
		t.Fatalf("mode %s", mode)
	}
	if got := c.PendingPermissions(""); len(got) != 0 {
		t.Fatalf("still pending: %+v", got)
	}
}

func TestSpecHandoffStartsTheNewSession(t *testing.T) {
	d := fakedaemon.Start(t, specScenario())
	c, r := start(t, d, controller.Config{})
	id := d.Sessions[0].SessionID
	p, next := askForSpec(t, c, r, id)
	if err := c.RespondToPermission(context.Background(), p.RequestID, controller.PermissionAnswer{
		SelectedOption:             protocol.ToolConfirmationOutcomeProceedNewSessionLow,
		ClientStartsHandoffSession: true,
	}); err != nil {
		t.Fatal(err)
	}
	if e, _ := r.wait(t, next, "turn end", turnEndedIn(id)); completion(e) != protocol.AgentTurnCompletionReasonSpecHandoff {
		t.Fatalf("turn ended %s", completion(e))
	}
	e, _ := r.wait(t, next, "handoff started", func(e controller.Event) bool {
		switch e.(type) {
		case controller.SpecHandoffStarted, controller.SpecHandoffFailed:
			return true
		}
		return false
	})
	started, ok := e.(controller.SpecHandoffStarted)
	if !ok || started.SessionID != id || started.RequestID != p.RequestID || started.NewSessionID == "" || started.NewSessionID == id {
		t.Fatalf("handoff: %+v", e)
	}
	newID := started.NewSessionID
	r.wait(t, next, "new Session's turn end", turnEndedIn(newID))
	s := c.Store().Session(newID)
	msgs := s.DisplayMessages()
	if len(msgs) < 2 || msgs[0].Role != "user" || !strings.HasPrefix(textOf(msgs[0]), "Implement the following plan:\n\n"+specPlan) {
		t.Fatalf("new Session's transcript: %+v", msgs)
	}
	if last := msgs[len(msgs)-1]; last.Role != "assistant" || textOf(last) != "Created hello.txt." {
		t.Fatalf("new Session's reply: %+v", last)
	}
	if set := s.Settings(); set.InteractionMode != protocol.DroidInteractionModeAuto || set.AutonomyLevel != protocol.AutonomyLevelLow {
		t.Fatalf("new Session's settings %s/%s", set.InteractionMode, set.AutonomyLevel)
	}
	if set := c.Store().Session(id).Settings(); set.InteractionMode != protocol.DroidInteractionModeAuto || set.AutonomyLevel != protocol.AutonomyLevelOff {
		t.Fatalf("planning Session's settings %s/%s", set.InteractionMode, set.AutonomyLevel)
	}
}

func TestSpecHandoffFailsWhenTheTurnEndsWithoutIt(t *testing.T) {
	d := fakedaemon.Start(t, fakedaemon.Scenario{
		Sessions: []fakedaemon.SessionSpec{{Title: "Chat", Cwd: "/Users/dev/acme-web"}},
		Turn:     &fakedaemon.Turn{Kind: "permission", Command: "npm test", Reply: "All tests pass."},
	})
	c, r := start(t, d, controller.Config{})
	ctx := context.Background()
	id := d.Sessions[0].SessionID
	if _, err := c.LoadSession(ctx, protocol.LoadSessionParams{SessionID: id}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddUserMessage(ctx, protocol.AddUserMessageParams{SessionID: id, Text: "Run the tests"}); err != nil {
		t.Fatal(err)
	}
	e, next := r.wait(t, 0, "permission requested", func(e controller.Event) bool { _, ok := e.(controller.PermissionRequested); return ok })
	p := e.(controller.PermissionRequested).Permission
	if err := c.RespondToPermission(ctx, p.RequestID, controller.PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedOnce, ClientStartsHandoffSession: true}); err != nil {
		t.Fatal(err)
	}
	e, _ = r.wait(t, next, "handoff failed", func(e controller.Event) bool { _, ok := e.(controller.SpecHandoffFailed); return ok })
	if f := e.(controller.SpecHandoffFailed); f.SessionID != id || f.RequestID != p.RequestID || f.Err == nil {
		t.Fatalf("failure: %+v", f)
	}
}

func TestSpecNewSessionWithoutTheClientImplementsInTheSession(t *testing.T) {
	d := fakedaemon.Start(t, specScenario())
	c, r := start(t, d, controller.Config{})
	id := d.Sessions[0].SessionID
	p, next := askForSpec(t, c, r, id)
	if err := c.RespondToPermission(context.Background(), p.RequestID, controller.PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedNewSessionMedium}); err != nil {
		t.Fatal(err)
	}
	e, next := r.wait(t, next, "implementing turn end", turnEnded)
	if completion(e) != protocol.AgentTurnCompletionReasonCompleted {
		t.Fatalf("implementing turn ended %s", completion(e))
	}
	if e, _ := r.wait(t, next, "planning turn end", turnEnded); completion(e) != protocol.AgentTurnCompletionReasonSpecHandoff {
		t.Fatalf("planning turn ended %s", completion(e))
	}
	msgs := c.Store().Session(id).DisplayMessages()
	var prompts int
	for _, m := range msgs {
		if m.Role == "user" && strings.HasPrefix(textOf(m), "Implement the following plan:") {
			prompts++
		}
	}
	if prompts != 1 || textOf(msgs[len(msgs)-1]) != "Created hello.txt." {
		t.Fatalf("transcript: %+v", msgs)
	}
	if set := c.Store().Session(id).Settings(); set.InteractionMode != protocol.DroidInteractionModeAuto || set.AutonomyLevel != protocol.AutonomyLevelMedium {
		t.Fatalf("settings %s/%s", set.InteractionMode, set.AutonomyLevel)
	}
}

func TestSpecModeAskedForAtInitialize(t *testing.T) {
	d := fakedaemon.Start(t, fakedaemon.Scenario{
		ValidDirectories: []string{"/Users/dev/acme-web"},
		Turn:             &fakedaemon.Turn{Kind: "spec", Plan: specPlan, Reply: "Created hello.txt."},
	})
	c, r := start(t, d, controller.Config{})
	res, err := c.InitializeSession(context.Background(), protocol.InitializeSessionParams{Cwd: "/Users/dev/acme-web", InteractionMode: protocol.DroidInteractionModeSpec})
	if err != nil {
		t.Fatal(err)
	}
	askForSpec(t, c, r, res.SessionID)
}
