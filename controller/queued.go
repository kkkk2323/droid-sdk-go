package controller

// A queued question set (droid 1.1) is AskUser with blocking false: the
// Daemon asks every Client and the tool returns at once, the agent keeps
// working, and the user's answers (or the dismissal) reach the agent at a
// later turn as a record message. The Daemon reports a set resolved with
// ask_user_resolved once the answer is saved, also when it asks a set again
// under a new request id.

// isQueued reads AskUser's blocking: only false makes a queued set.
func isQueued(blocking *bool) bool { return blocking != nil && !*blocking }

// onAskUserResolved drops the AskUser prompts the Daemon reports resolved,
// here or on another Client. A load in flight notes them, as its snapshot
// may still hold them; c.mu is held.
func (c *Controller) onAskUserResolved(sessionID string, requestIDs []string, out []Event) []Event {
	lc := c.loadInFlight(sessionID)
	for _, id := range requestIDs {
		if lc != nil && lc.askResolved != nil {
			lc.askResolved[id] = true
		}
		a := c.prompts.asks[id]
		if a == nil {
			continue
		}
		// An answer kept for the worker's return is no longer owed.
		delete(c.prompts.bufAsk[a.SessionID], a.ToolCallID)
		out = c.prompts.dropAskUser(id, nil, out)
	}
	return out
}
