package executor

import (
	"net"
	"testing"
)

func TestValidateIPBlocksNonPublicRanges(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"}
	for _, value := range blocked {
		if err := ValidateIP(net.ParseIP(value)); err == nil {
			t.Errorf("expected %s to be blocked", value)
		}
	}
}

func TestValidateIPAllowsPublicAddresses(t *testing.T) {
	for _, value := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if err := ValidateIP(net.ParseIP(value)); err != nil {
			t.Errorf("expected %s to be allowed: %v", value, err)
		}
	}
}
