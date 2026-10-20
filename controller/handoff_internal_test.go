package controller

import (
	"encoding/json"
	"testing"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

func TestPermissionResponseCarriesTheSpecHandoff(t *testing.T) {
	a := PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedNewSessionLow, ClientStartsHandoffSession: true}
	b, err := json.Marshal(permissionResponse("s1", a, "h1"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b); got != `{"selectedOption":"proceed_new_session_low","sessionId":"s1","clientStartsHandoffSession":true,"specHandoffId":"h1"}` {
		t.Fatalf("wire %s", got)
	}
	b, _ = json.Marshal(permissionResponse("s1", PermissionAnswer{SelectedOption: protocol.ToolConfirmationOutcomeProceedOnce}, ""))
	if got := string(b); got != `{"selectedOption":"proceed_once","sessionId":"s1"}` {
		t.Fatalf("wire %s", got)
	}
}

func TestAnAnswerWithoutAHandoffDropsThePendingOne(t *testing.T) {
	p := newPrompts()
	id, created := p.startHandoff("s1", "r1", true)
	if id == "" || !created {
		t.Fatal("no handoff")
	}
	if again, created := p.startHandoff("s1", "r1", true); again != id || created {
		t.Fatalf("answered again: %q, %v", again, created)
	}
	p.bufPerm["tu1"] = bufferedPermission{sessionID: "s1", specHandoffID: id}
	out := p.failHandoff("s1", errNoHandoffSession, nil)
	if len(out) != 1 || len(p.bufPerm) != 0 || len(p.handoffs) != 0 {
		t.Fatalf("failed: %+v, %d buffered", out, len(p.bufPerm))
	}
	p.startHandoff("s1", "r2", true)
	if id, _ := p.startHandoff("s1", "r3", false); id != "" || len(p.handoffs) != 0 {
		t.Fatalf("kept %+v", p.handoffs)
	}
}
