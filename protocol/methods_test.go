package protocol

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// The SDK passes these overrides across several lines; a generator that
// misses them leaves the method on the Client's 30s default.
func TestMethodTimeoutOverrides(t *testing.T) {
	want := map[string]time.Duration{
		MethodAuthenticateMCPServer: 300 * time.Second,
		MethodCompactSession:        240 * time.Second,
		MethodCleanupWorktree:       180 * time.Second,
		MethodGenerateSemanticDiff:  180 * time.Second,
		MethodPushCwdFileToURL:      900 * time.Second,
		MethodPullURLToCwdFile:      900 * time.Second,
	}
	for method, d := range want {
		if got := Methods[method].Timeout; got != d {
			t.Errorf("%s: timeout %v, want %v", method, got, d)
		}
	}
}

// A union branch whose discriminator is a z.enum decodes for each of its
// values into that branch's shape.
func TestUnionBranchWithSeveralDiscriminatorValues(t *testing.T) {
	for state, want := range map[string]string{"draft": "*protocol.DaemonCheckoutPullRequestOpen", "closed": "*protocol.DaemonCheckoutPullRequestOpen", "none": "*protocol.DaemonCheckoutPullRequestNone"} {
		var u DaemonCheckoutPullRequest
		if err := json.Unmarshal([]byte(`{"state":"`+state+`"}`), &u); err != nil {
			t.Fatal(err)
		}
		v, err := u.Value()
		if err != nil {
			t.Fatal(err)
		}
		if got := fmt.Sprintf("%T", v); got != want {
			t.Errorf("%s: %s, want %s", state, got, want)
		}
	}
}

// Requests the TS client never sends are still the Client's methods, not
// requests of the Daemon; only DaemonDroidEvent's are.
func TestMethodsTheTSClientDoesNotCall(t *testing.T) {
	for _, m := range []string{MethodGetGitBranchDivergence, MethodWarmupCache, MethodDesktopStatus, MethodDispatchAutomationRun, MethodKillBackgroundProcess} {
		if _, ok := Methods[m]; !ok || NewResult(m) == nil {
			t.Errorf("%s is not in the method table", m)
		}
	}
	if NewParams(MethodKillBackgroundProcess) == nil {
		t.Error("no params for daemon.kill_background_process")
	}
}

func TestDroid10LoadResultFields(t *testing.T) {
	var r LoadSessionResult
	raw := `{"session":{"messages":[]},"settings":{},"backgroundWork":2,"backgroundProcesses":{"capturedAtMs":5,"processes":[{"id":"tu1","pid":42,"command":"sleep 60","startedAtMs":4,"toolUseId":"tu1","outputFile":"/tmp/o.log"}]}}`
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		t.Fatal(err)
	}
	if r.BackgroundWork == nil || *r.BackgroundWork != 2 || r.BackgroundProcesses == nil || len(r.BackgroundProcesses.Processes) != 1 || r.BackgroundProcesses.Processes[0].Pid != 42 {
		t.Fatalf("decoded %+v", r)
	}
}
