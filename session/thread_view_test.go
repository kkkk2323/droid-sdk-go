package session

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"slices"
	"testing"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

// Whatever comes to a thread, what all and display give is what reading it
// again from scratch gives: messages added at the end, slotted in by seq or
// parent, replaced, hidden, given a seq, removed, or the thread reset.
func TestTheThreadsViewsFollowItsChanges(t *testing.T) {
	for seed := range uint64(30) {
		threadViewsAgainstFreshReads(t, seed)
	}
}

func threadViewsAgainstFreshReads(t *testing.T, seed uint64) {
	rnd := rand.New(rand.NewPCG(seed, 7))
	th := newThread()
	n := 0
	var ids []string
	text := func(s string) []protocol.ContentBlock {
		return []protocol.ContentBlock{blockOf(protocol.TextBlock{Type: blockText, Text: s})}
	}
	newMessage := func() message {
		n++
		m := message{ID: fmt.Sprintf("m%d", n), CreatedAt: float64(n), Role: roleAssistant, Content: text("reply")}
		switch rnd.IntN(5) {
		case 0:
			m.Role, m.Content = roleUser, text("<system-reminder>for the model</system-reminder>")
		case 1:
			m.Role, m.Content = roleUser, text("go on")
		case 2:
			m.Role = roleTool
			m.Content = []protocol.ContentBlock{blockOf(map[string]any{"type": blockToolResult, "toolUseId": "t", "content": "ok"})}
		}
		if len(ids) > 0 && rnd.IntN(3) > 0 {
			m.ParentID = ids[rnd.IntN(len(ids))]
		}
		if rnd.IntN(4) == 0 {
			s := int64(rnd.IntN(2 * (n + 1)))
			m.Seq = &s
		}
		if rnd.IntN(10) == 0 {
			m.Visibility = protocol.MessageVisibilityLLMOnly
		}
		return m
	}
	for step := range 300 {
		// Read them first, so that the changes below keep them up to date.
		if rnd.IntN(3) > 0 {
			th.all()
			th.display()
		}
		switch op := rnd.IntN(10); {
		case op < 5 || len(ids) == 0:
			m := newMessage()
			th.add(m)
			ids = append(ids, m.ID)
		case op < 8:
			id := ids[rnd.IntN(len(ids))]
			m, _ := th.get(id)
			switch rnd.IntN(4) {
			case 0:
				m.Content = text(fmt.Sprintf("edited %d", step))
			case 1:
				hidden := !(m.HiddenFromUserViews != nil && *m.HiddenFromUserViews)
				m.HiddenFromUserViews = &hidden
			case 2:
				s := int64(rnd.IntN(2 * n))
				m.Seq = &s
			default:
				m.Content = text("<system-reminder>gone</system-reminder>")
			}
			th.add(m)
		case op == 8:
			i := rnd.IntN(len(ids))
			th.remove(ids[i])
			ids = append(ids[:i], ids[i+1:]...)
		default:
			fresh := freshAll(&th)
			rnd.Shuffle(len(fresh), func(i, j int) { fresh[i], fresh[j] = fresh[j], fresh[i] })
			th.reset(fresh[:len(fresh)/2])
			ids = ids[:0]
			for _, m := range fresh[:len(fresh)/2] {
				ids = append(ids, m.ID)
			}
		}
		want := freshAll(&th)
		if got := th.all(); !reflect.DeepEqual(got, want) && !(len(got) == 0 && len(want) == 0) {
			t.Fatalf("seed %d, step %d: all is %v, the thread reads %v", seed, step, messageIDs(got), messageIDs(want))
		}
		wantShown := FilterMessagesForUI(want)
		if got := th.display(); !reflect.DeepEqual(got, wantShown) && !(len(got) == 0 && len(wantShown) == 0) {
			t.Fatalf("seed %d, step %d: display is %v, the thread shows %v", seed, step, messageIDs(got), messageIDs(wantShown))
		}
	}
}

// freshAll reads the thread's messages from its order, as all did before it
// kept them.
func freshAll(t *thread) []message {
	out := make([]message, 0, len(t.order))
	for _, id := range t.order {
		out = append(out, t.byID[id])
	}
	return out
}

// Trimming keeps the latest messages, says there are older ones, keeps the
// todo list, and the older pages come back.
func TestTrimOlderMessages(t *testing.T) {
	s := NewStore()
	var msgs []protocol.FactoryDroidMessage
	for i := range 10 {
		m := protocol.FactoryDroidMessage{ID: fmt.Sprintf("m%d", i), Role: roleUser, CreatedAt: float64(i), Content: []protocol.ContentBlock{blockOf(protocol.TextBlock{Type: blockText, Text: "hi"})}}
		if i > 0 {
			m.ParentID = fmt.Sprintf("m%d", i-1)
		}
		msgs = append(msgs, m)
	}
	s.LoadSession("s", msgs, LoadOptions{})
	sess := s.Session("s")
	if s.TrimOlderMessages("s", 20) || s.TrimOlderMessages("missing", 1) {
		t.Fatal("trimmed what it had no need to")
	}
	if !s.TrimOlderMessages("s", 4) {
		t.Fatal("did not trim")
	}
	if got := messageIDs(sess.Messages()); !slices.Equal(got, []string{"m6", "m7", "m8", "m9"}) {
		t.Fatalf("kept %v", got)
	}
	if c, ok := sess.OlderMessagesCursor(); !sess.HasOlderMessages() || !ok || c != "m6" {
		t.Fatalf("older: %v %q %v", sess.HasOlderMessages(), c, ok)
	}
	var shown []string
	sess.ReadDisplayMessages(func(ms []protocol.FactoryDroidMessage) { shown = messageIDs(ms) })
	if len(shown) != 4 {
		t.Fatalf("shows %v", shown)
	}
	s.PrependOlderMessages("s", msgs[2:6], true)
	if got := messageIDs(sess.Messages()); !slices.Equal(got, []string{"m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"}) {
		t.Fatalf("after the older page %v", got)
	}
}
