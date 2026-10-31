package session

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

// notificationBackgroundProcessesChanged is newer than the generated
// notification union (droid 1.0), which decodes it to nil. The Daemon sends
// it with every background process the Session tracks when one starts or
// ends.
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
