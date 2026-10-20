package controller

import (
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

// notificationSpecHandoffSessionCreated is newer than the generated
// notification union, which decodes it to nil.
const notificationSpecHandoffSessionCreated = "spec_handoff_session_created"

// specHandoffSessionCreated: the Daemon created the Session a spec handoff
// answer asked for, without starting it.
type specHandoffSessionCreated struct {
	NewSessionID  string `json:"newSessionId"`
	InitialPrompt string `json:"initialPrompt"`
	SpecHandoffID string `json:"specHandoffId"`
}

var errNoHandoffSession = errors.New("droid: agent turn ended without creating the spec handoff session")

// startHandoff records the spec handoff an answer to requestID starts and
// returns its id, "" when the answer starts none. A repeated answer to the
// same permission keeps its id; an answer without a handoff drops the
// Session's.
func (p *prompts) startHandoff(sessionID, requestID string, clientStarts bool) (id string, created bool) {
	if !clientStarts {
		delete(p.handoffs, sessionID)
		return "", false
	}
	if h, ok := p.handoffs[sessionID]; ok && h.requestID == requestID {
		return h.id, false
	}
	h := specHandoff{id: uuid.NewString(), requestID: requestID}
	p.handoffs[sessionID] = h
	return h.id, true
}

// failHandoff drops a Session's pending spec handoff, and the answer kept
// for it, as failed.
func (p *prompts) failHandoff(sessionID string, err error, out []Event) []Event {
	h, ok := p.handoffs[sessionID]
	if !ok {
		return out
	}
	delete(p.handoffs, sessionID)
	for id, b := range p.bufPerm {
		if b.specHandoffID == h.id {
			delete(p.bufPerm, id)
		}
	}
	return append(out, SpecHandoffFailed{SessionID: sessionID, RequestID: h.requestID, Err: err})
}

func (c *Controller) failHandoff(sessionID string, err error) {
	c.mu.Lock()
	out := c.prompts.failHandoff(sessionID, err, nil)
	c.mu.Unlock()
	c.push(out)
}

// onSpecHandoffCreated takes the Session's pending spec handoff at once,
// as the turn's end follows right after; c.mu is held.
func (c *Controller) onSpecHandoffCreated(sessionID string, raw json.RawMessage) {
	var n specHandoffSessionCreated
	if err := json.Unmarshal(raw, &n); err != nil {
		c.log.Warn("droid: undecodable spec handoff notification", "err", err)
		return
	}
	h, ok := c.prompts.handoffs[sessionID]
	if !ok {
		return
	}
	delete(c.prompts.handoffs, sessionID)
	go c.startHandoffSession(sessionID, h, n)
}

// startHandoffSession loads the new Session of a spec handoff and sends it
// the plan as its first message.
func (c *Controller) startHandoffSession(sessionID string, h specHandoff, n specHandoffSessionCreated) {
	started := SpecHandoffStarted{SessionID: sessionID, NewSessionID: n.NewSessionID, RequestID: h.requestID}
	// Another answer's handoff: the Client that gave it starts the Session.
	if n.SpecHandoffID != h.id {
		c.events.push(started)
		return
	}
	ctx, cancel := c.stopContext()
	defer cancel()
	_, err := c.LoadSession(ctx, protocol.LoadSessionParams{SessionID: n.NewSessionID})
	if err == nil {
		_, err = c.AddUserMessage(ctx, protocol.AddUserMessageParams{SessionID: n.NewSessionID, Text: n.InitialPrompt})
	}
	if err != nil {
		c.events.push(SpecHandoffFailed{SessionID: sessionID, RequestID: h.requestID, Err: err})
		return
	}
	c.events.push(started)
}
