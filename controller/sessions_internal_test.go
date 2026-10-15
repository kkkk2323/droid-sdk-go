package controller

import (
	"testing"

	"github.com/kkkk2323/droid-sdk-go/protocol"
)

func TestALoadAsksOtherSpawnOptionsOnlyForOnesItSets(t *testing.T) {
	yes, no := ptr(true), ptr(false)
	cases := []struct {
		name    string
		p, used protocol.LoadSessionParams
		want    bool
	}{
		{"nothing set", protocol.LoadSessionParams{}, protocol.LoadSessionParams{DisableInactivityTimeout: yes}, false},
		{"the same", protocol.LoadSessionParams{DisableInactivityTimeout: yes}, protocol.LoadSessionParams{DisableInactivityTimeout: yes}, false},
		{"unset before", protocol.LoadSessionParams{DisableInactivityTimeout: yes}, protocol.LoadSessionParams{}, true},
		{"the other way", protocol.LoadSessionParams{DisableInactivityTimeout: no}, protocol.LoadSessionParams{DisableInactivityTimeout: yes}, true},
		{"settings path", protocol.LoadSessionParams{RuntimeSettingsPath: "/a"}, protocol.LoadSessionParams{RuntimeSettingsPath: "/b"}, true},
	}
	for _, tc := range cases {
		if got := asksOtherSpawn(tc.p, tc.used); got != tc.want {
			t.Errorf("%s: %v", tc.name, got)
		}
	}
}
