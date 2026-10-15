package droid_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	droid "github.com/kkkk2323/droid-sdk-go"
	"github.com/kkkk2323/droid-sdk-go/fakedaemon"
	"github.com/kkkk2323/droid-sdk-go/protocol"
)

func sessionCron(t *testing.T, r protocol.CronRecord) *protocol.SessionCronRecord {
	t.Helper()
	v, err := r.Value()
	if err != nil {
		t.Fatal(err)
	}
	c, ok := v.(*protocol.SessionCronRecord)
	if !ok {
		t.Fatalf("not a session cron: %s", r.Kind)
	}
	return c
}

func TestFakeDaemonKeepsLoopsAndTellsEveryChange(t *testing.T) {
	d := fakedaemon.Start(t, fakedaemon.Scenario{Input: map[string]any{"crons": []map[string]any{
		{"id": "held", "sessionId": "s1", "prompt": "check CI", "expression": "*/10 * * * *", "status": "held"},
		{"id": "other", "sessionId": "s2", "prompt": "tidy", "expression": "0 * * * *"},
	}}})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, err := droid.Dial(ctx, droid.Options{URL: d.URL, Credential: &droid.Credential{APIKey: "fk-test"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	changes := make(chan protocol.CronStateChangedParams, 8)
	c.Subscribe(func(n droid.Notification) {
		if n.Method == protocol.NotificationCronStateChanged {
			var p protocol.CronStateChangedParams
			_ = json.Unmarshal(n.Params, &p)
			changes <- p
		}
	})
	next := func() protocol.CronStateChangedParams {
		t.Helper()
		select {
		case p := <-changes:
			return p
		case <-time.After(5 * time.Second):
			t.Fatal("no daemon.cron.state_changed")
			return protocol.CronStateChangedParams{}
		}
	}

	listed, err := c.ListCrons(ctx, protocol.ListCronsParams{SessionID: "s1"})
	if err != nil || len(listed.Crons) != 1 {
		t.Fatalf("list %v %+v", err, listed)
	}
	if h := sessionCron(t, listed.Crons[0]); h.Status != protocol.CronStatusHeld || h.HoldReason != "daemon-start" {
		t.Fatalf("held %+v", h)
	}

	resumed, err := c.ResumeSessionCrons(ctx, protocol.ResumeSessionCronsParams{SessionID: "s1"})
	if err != nil || resumed.ResumedCount != 1 {
		t.Fatalf("resume %v %+v", err, resumed)
	}
	if p := next(); p.Reason != protocol.CronStateChangedParamsReasonUpdated || sessionCron(t, p.Crons[0]).Status != protocol.CronStatusActive {
		t.Fatalf("resumed %+v", p)
	}

	create, _ := protocol.NewDaemonCreateCronRequestParams(protocol.DaemonCreateCronRequestParamsSessionPrompt{
		Kind: "session_prompt", Source: protocol.CronSourceLoopCommand,
		Schedule: protocol.DaemonCreateCronRequestParamsSessionPromptSchedule{Expression: "5,35 * * * *", Recurring: true},
		Scope:    protocol.CronCreateSessionScope{Type: "session", SessionID: "s1", SessionCwd: "/Users/dev/app"},
		Payload:  protocol.SameSessionPromptPayload{Type: "prompt", Prompt: "run the tests", Target: protocol.SameSessionPromptPayloadTarget{Type: "same_session"}},
	})
	made, err := c.CreateCron(ctx, create)
	if err != nil {
		t.Fatal(err)
	}
	loop := sessionCron(t, made.Cron)
	if loop.Payload.Prompt != "run the tests" || loop.Scope.SessionCwd != "/Users/dev/app" || loop.Status != protocol.CronStatusActive {
		t.Fatalf("created %+v", loop)
	}
	if p := next(); p.Reason != protocol.CronStateChangedParamsReasonCreated || p.CronIDs[0] != loop.ID {
		t.Fatalf("created %+v", p)
	}

	paused, err := c.UpdateCron(ctx, protocol.UpdateCronParams{CronID: loop.ID, Status: protocol.UserUpdatableCronStatusPaused})
	if err != nil || sessionCron(t, *paused.Cron).Status != protocol.CronStatusPaused {
		t.Fatalf("pause %v %+v", err, paused)
	}
	next()

	deleted, err := c.DeleteCron(ctx, protocol.DeleteCronParams{CronID: "held", SessionID: "s1"})
	if err != nil || !deleted.Deleted {
		t.Fatalf("delete %v %+v", err, deleted)
	}
	if p := next(); p.Reason != protocol.CronStateChangedParamsReasonDeleted || p.CronIDs[0] != "held" {
		t.Fatalf("deleted %+v", p)
	}
	if listed, _ := c.ListCrons(ctx, protocol.ListCronsParams{}); len(listed.Crons) != 2 {
		t.Fatalf("left %+v", listed)
	}
}
