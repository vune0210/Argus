package executor

import (
	"context"
	"fmt"
	"net"
)

type SSRFError struct {
	Target string
}

func (e *SSRFError) Error() string {
	return fmt.Sprintf("target %s is not a permitted public address", e.Target)
}

func ValidateIP(ip net.IP) error {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || !ip.IsGlobalUnicast() {
		return &SSRFError{Target: ip.String()}
	}
	return nil
}

func guardedDialer(allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	resolver := net.DefaultResolver
	dialer := &net.Dialer{}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("invalid dial address: %w", err)
		}
		addresses, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(addresses) == 0 {
			return nil, &net.DNSError{Name: host, Err: "no addresses"}
		}
		var lastError error
		for _, candidate := range addresses {
			if !allowPrivate {
				if err := ValidateIP(candidate.IP); err != nil {
					lastError = err
					continue
				}
			}
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
			if err == nil {
				return connection, nil
			}
			lastError = err
		}
		if lastError == nil {
			lastError = &SSRFError{Target: host}
		}
		return nil, lastError
	}
}
