// Package fakedaemon runs the Fake Daemon (../fake-daemon), the Node stand-in
// for `droid daemon` and droi's Gateway, for Go tests. It embeds the Fake
// Daemon bundled into one script (fake-daemon.mjs, written by `pnpm build`),
// so it needs only Node at test time.
package fakedaemon

import (
	"bufio"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

//go:embed fake-daemon.mjs
var bundled []byte

// Scenario says what the Fake Daemon answers.
type Scenario struct {
	Sessions         []SessionSpec `json:"sessions,omitempty"`
	Turn             *Turn         `json:"turn,omitempty"`
	ValidDirectories []string      `json:"validDirectories,omitempty"`
	// Input holds more of the Fake Daemon's ScenarioInput (commands, skills,
	// mcpServers, mcpRegistry, files, defaults, opened, automations, crons...),
	// as JSON.
	Input map[string]any `json:"input,omitempty"`
}

// SessionSpec is a Session that exists from the start.
type SessionSpec struct {
	Title    string         `json:"title"`
	Cwd      string         `json:"cwd"`
	Messages []Message      `json:"messages,omitempty"`
	Extra    map[string]any `json:"extra,omitempty"`
}

// Message is a message in a Session's history: Role "user", "assistant" or
// "tool", with Text, or with Content blocks as the Daemon sends them
// (thinking, tool_use, tool_result...) in place of Text.
type Message struct {
	Role    string           `json:"role"`
	Text    string           `json:"text,omitempty"`
	Content []map[string]any `json:"content,omitempty"`
}

// Turn is how the agent answers daemon.add_user_message: Kind is "reply"
// (Deltas streamed), "permission" (asks to run Command, then Reply),
// "askUser" (Question with Options), "queuedAskUser" (droid 1.1's queued
// question: Question with Options and Context asked without waiting, Reply
// streamed meanwhile; an answer is saved as a receipt, reported resolved
// with ask_user_resolved, and starts a turn on its record), "todo", "structured" (a Memory
// Session's turn, ending with Structured as its structured output), or
// "spec" (in a Session in Spec mode, presents Plan titled Title with
// ExitSpecMode and acts on the answer as droid 0.244 does, streaming Reply
// once approved; elsewhere, such as in the Session a spec handoff creates,
// only streams Reply). A Session starts in Spec mode with Extra
// {"settings": {"interactionMode": "spec"}}, or initialize_session's
// interactionMode. "backgroundProcess" runs Command in the background (an
// Execute with fireAndForget, answered with droid 1.0's launch text "Background
// process started (PID: Pid)\nCommand: ...\nOutput: OutputFile..."), reports it
// with background_processes_changed and in load_session's
// backgroundProcesses, and ends the turn with Reply while it runs;
// daemon.kill_background_process stops it, reports the list without it and
// starts the turn droid starts on the command's end. Pid defaults to 48213,
// OutputFile to a file under /tmp named after the tool use.
type Turn struct {
	Kind        string         `json:"kind"`
	Deltas      []string       `json:"deltas,omitempty"`
	DelayMs     int            `json:"delayMs,omitempty"`
	Command     string         `json:"command,omitempty"`
	Reply       string         `json:"reply,omitempty"`
	ToolOutput  string         `json:"toolOutput,omitempty"`
	Question    string         `json:"question,omitempty"`
	Options     []string       `json:"options,omitempty"`
	MultiSelect bool           `json:"multiSelect,omitempty"`
	Context     string         `json:"context,omitempty"`
	Todos       []Todo         `json:"todos,omitempty"`
	Structured  map[string]any `json:"structured,omitempty"`
	Plan        string         `json:"plan,omitempty"`
	Title       string         `json:"title,omitempty"`
	Pid         int            `json:"pid,omitempty"`
	OutputFile  string         `json:"outputFile,omitempty"`
}

// Todo is an item of a todo turn's list.
type Todo struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	Status  string `json:"status"`
}

// Daemon is a running Fake Daemon.
type Daemon struct {
	// URL is the WebSocket URL to connect to, token included.
	URL string
	// Sessions are the scenario's Sessions with the ids the Daemon gave them.
	Sessions []StartedSession

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	mu     sync.Mutex
	nextID int
	wait   map[int]chan json.RawMessage
}

// StartedSession is a scenario Session as the Daemon knows it.
type StartedSession struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
}

var (
	writeOnce sync.Once
	bundle    string
	writeErr  error
)

// write puts the bundled Fake Daemon in a file Node can run, once per test
// binary.
func write() (string, error) {
	writeOnce.Do(func() {
		if _, err := exec.LookPath("node"); err != nil {
			writeErr = fmt.Errorf("the Fake Daemon needs Node: %w", err)
			return
		}
		dir, err := os.MkdirTemp("", "droid-fake-daemon")
		if err != nil {
			writeErr = err
			return
		}
		bundle = filepath.Join(dir, "fake-daemon.mjs")
		writeErr = os.WriteFile(bundle, bundled, 0o644)
	})
	return bundle, writeErr
}

// Start runs a Fake Daemon for the test, skipping the test when there is no
// Node, and stops it when the test ends.
func Start(t testing.TB, sc Scenario) *Daemon {
	t.Helper()
	script, err := write()
	if err != nil {
		t.Skip(err)
	}
	spec, _ := json.Marshal(sc)
	cmd := exec.Command("node", script)
	cmd.Env = append(os.Environ(), "DROID_FAKE_SCENARIO="+string(spec))
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	d := &Daemon{cmd: cmd, stdin: stdin, wait: map[int]chan json.RawMessage{}}
	sc2 := bufio.NewScanner(stdout)
	sc2.Buffer(make([]byte, 1<<20), 64<<20)
	ready := make(chan error, 1)
	go func() {
		first := true
		for sc2.Scan() {
			line := append([]byte(nil), sc2.Bytes()...)
			if first {
				first = false
				ready <- json.Unmarshal(line, &struct {
					URL      *string           `json:"url"`
					Sessions *[]StartedSession `json:"sessions"`
				}{&d.URL, &d.Sessions})
				continue
			}
			var head struct {
				ID int `json:"id"`
			}
			if json.Unmarshal(line, &head) != nil {
				continue
			}
			d.mu.Lock()
			ch := d.wait[head.ID]
			delete(d.wait, head.ID)
			d.mu.Unlock()
			if ch != nil {
				ch <- line
			}
		}
		if first {
			ready <- fmt.Errorf("fake daemon exited before it started")
		}
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("fake daemon did not start")
	}
	t.Cleanup(func() {
		stdin.Close()
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
		}
	})
	return d
}

// Command sends a control command and returns its answer.
func (d *Daemon) Command(op string, args map[string]any) (json.RawMessage, error) {
	d.mu.Lock()
	d.nextID++
	id := d.nextID
	ch := make(chan json.RawMessage, 1)
	d.wait[id] = ch
	d.mu.Unlock()
	m := map[string]any{"id": id, "op": op}
	for k, v := range args {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	if _, err := d.stdin.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	select {
	case line := <-ch:
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(line, &e) == nil && e.Error != "" {
			return nil, fmt.Errorf("fake daemon: %s", e.Error)
		}
		return line, nil
	case <-time.After(15 * time.Second):
		return nil, fmt.Errorf("fake daemon: %s: no answer", op)
	}
}

// GoDown drops every connection and refuses new ones, as a dead Daemon.
func (d *Daemon) GoDown() error { _, err := d.Command("goDown", nil); return err }

// ComeBack accepts connections again.
func (d *Daemon) ComeBack() error { _, err := d.Command("comeBack", nil); return err }

// Notify sends a session notification to the Clients attached to a Session.
func (d *Daemon) Notify(sessionID string, notification map[string]any) error {
	_, err := d.Command("notify", map[string]any{"sessionId": sessionID, "notification": notification})
	return err
}

// Write puts an unwritten Session on disk: the Daemon lists it from now on.
func (d *Daemon) Write(sessionID string) error {
	_, err := d.Command("write", map[string]any{"sessionId": sessionID})
	return err
}

// Request is a request the Daemon received.
type Request struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Requests returns every request received so far.
func (d *Daemon) Requests() ([]Request, error) {
	line, err := d.Command("requests", nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Requests []Request `json:"requests"`
	}
	return out.Requests, json.Unmarshal(line, &out)
}

// WaitForRequest waits for the nth request of a method.
func (d *Daemon) WaitForRequest(method string, nth int) (Request, error) {
	line, err := d.Command("waitForRequest", map[string]any{"method": method, "nth": nth, "timeoutMs": 10000})
	if err != nil {
		return Request{}, err
	}
	var out struct {
		Request Request `json:"request"`
	}
	return out.Request, json.Unmarshal(line, &out)
}
