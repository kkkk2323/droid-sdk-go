package session

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

// notificationBackgroundProcessesChanged (droid 1.0) is read from its raw
// JSON, as @factory/droid-sdk before 0.11 lacked it. The Daemon sends it with
// every background process the Session tracks when one starts or ends.
const notificationBackgroundProcessesChanged = "background_processes_changed"

func (s *Store) handleBackgroundProcessesChanged(sessionID string, raw json.RawMessage) error {
	var n protocol.BackgroundProcessesChangedNotification
	if err := json.Unmarshal(raw, &n); err != nil {
		return fmt.Errorf("session: decode %s notification: %w", notificationBackgroundProcessesChanged, err)
	}
	s.update(func() { s.handle(sessionID, pendingNotification{typ: notificationBackgroundProcessesChanged, v: &n}) })
	return nil
}

// setBackground replaces the Session's background processes with a
// snapshot; nil clears them (the worker that ran them is gone). A snapshot
// taken before the one held is ignored. Every call counts as an update, so
// that a load in flight drops the snapshot it captured before.
func (st *state) setBackground(snap *protocol.SessionBackgroundProcessesSnapshot) {
	st.backgroundRevision++
	if snap == nil && st.background == nil {
		return
	}
	if snap != nil && st.background != nil && snap.CapturedAtMs < st.background.CapturedAtMs {
		return
	}
	if snap != nil {
		c := *snap
		c.Processes = slices.Clone(snap.Processes)
		snap = &c
	}
	st.background = snap
	st.emit(EventMetadataUpdated)
}

// setBackgroundWork keeps the Daemon's count of the Session's background
// work.
func (st *state) setBackgroundWork(n int) {
	if st.backgroundWorkKnown && st.backgroundWork == n {
		return
	}
	st.backgroundWork, st.backgroundWorkKnown = n, true
	st.emit(EventMetadataUpdated)
}

// BackgroundWork is how much work the Session's agent left running that
// will wake it, as the Daemon last counted it: background processes,
// Scripts left running, and the ends of such work it still owes the
// agent. droid tells
// it with droid_working_state_changed as the Session goes idle, and in
// daemon.load_session's result; known is false until it told (an older
// droid never does). The count stands while a turn runs, and drops to 0
// when the Session's worker exits, which ends that work.
func (h *Session) BackgroundWork() (n int, known bool) {
	h.read(func(st *state) { n, known = st.backgroundWork, st.backgroundWorkKnown })
	return n, known
}

// BackgroundProcesses are the processes the Session's agent started in the
// background (a fire-and-forget Execute) that still run, as the Daemon
// last reported them (droid 1.0); nil when it reported none, or is older.
// Pid and OutputFile are of the computer that hosts the Session.
// daemon.kill_background_process stops one; the Daemon then reports the
// list without it.
func (h *Session) BackgroundProcesses() (out []protocol.SessionBackgroundProcess) {
	h.read(func(st *state) {
		if st.background != nil && len(st.background.Processes) > 0 {
			out = slices.Clone(st.background.Processes)
		}
	})
	return out
}
