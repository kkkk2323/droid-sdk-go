package session

import (
	"encoding/json"
	"fmt"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

// notificationChildSessionSettled is newer than the generated notification
// union (droid 1.1), which decodes it to nil. The Daemon sends it on a
// parent Session when one of its Task children reaches a terminal outcome,
// so that a Client that cannot reach the child's computer can settle it.
const notificationChildSessionSettled = "child_session_settled"

type childSessionSettled struct {
	ChildSessionID string                        `json:"childSessionId"`
	ToolUseID      string                        `json:"toolUseId"`
	Status         protocol.TaskInvocationStatus `json:"status"`
}

func (s *Store) handleChildSessionSettled(raw json.RawMessage) error {
	var n childSessionSettled
	if err := json.Unmarshal(raw, &n); err != nil {
		return fmt.Errorf("session: decode %s notification: %w", notificationChildSessionSettled, err)
	}
	if !valid(n.ChildSessionID) {
		return nil
	}
	s.update(func() { s.childSessionSettled(n) })
	return nil
}

// childSessionSettled settles a subagent on its parent's word: its summary
// takes the status, which outranks one recorded before, and the child goes
// idle as on a live working-state change, so that a load that captured it
// running cannot bring that back. A settle for an earlier Task of a child
// that a later one resumed is ignored.
func (s *Store) childSessionSettled(n childSessionSettled) {
	st := s.sessions[n.ChildSessionID]
	if st != nil && n.ToolUseID != "" && st.callingToolUseID != "" && n.ToolUseID != st.callingToolUseID {
		return
	}
	// A status this reader does not know reads as a failure rather than a
	// success it cannot confirm.
	status := n.Status
	if !terminalStatus(status) {
		status = protocol.TaskInvocationStatusFailed
	}
	if sum, ok := s.summaries[n.ChildSessionID]; ok && sum.Status != status {
		sum.Status = status
		s.setSummary(sum)
	}
	if st != nil {
		st.workingRevision++
		st.transition(protocol.DroidWorkingStateIdle)
	}
}
