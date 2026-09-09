package executor

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type SSLExecutor struct {
	ProbeID            string
	Region             string
	AllowPrivateTarget bool
}

func (e SSLExecutor) Execute(parent context.Context, job contracts.ProbeJob) contracts.ProbeResult {
	startedAt := time.Now().UTC()
	schemaVersion := job.SchemaVersion
	if schemaVersion == "" {
		schemaVersion = contracts.SchemaVersion
	}
	result := contracts.ProbeResult{
		SchemaVersion:  schemaVersion,
		ExecutionID:    job.ExecutionID,
		OrganizationID: job.OrganizationID,
		MonitorID:      job.MonitorID,
		MonitorVersion: job.MonitorVersion,
		ProbeID:        e.ProbeID,
		Region:         e.Region,
		StartedAt:      startedAt,
		Outcome:        contracts.OutcomeFail,
	}

	timeout := time.Duration(job.Config.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if !job.DeadlineAt.IsZero() && job.DeadlineAt.Before(deadline) {
		deadline = job.DeadlineAt
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()

	port := job.Config.Port
	if port <= 0 {
		port = 443
	}
	addr := net.JoinHostPort(job.Config.Host, strconv.Itoa(port))
	serverName := job.Config.ServerName
	if serverName == "" {
		serverName = job.Config.Host
	}

	dialer := guardedDialer(e.AllowPrivateTarget)
	rawConn, err := dialer(ctx, "tcp", addr)
	if err != nil {
		completedAt := time.Now().UTC()
		result.CompletedAt = completedAt
		result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
		result.ErrorCode = normalizeError(err)
		result.ErrorMessage = safeMessage(err)
		return result
	}
	defer rawConn.Close()

	tlsConfig := &tls.Config{
		ServerName: serverName,
		MinVersion: tls.VersionTLS12,
	}
	tlsConn := tls.Client(rawConn, tlsConfig)
	defer tlsConn.Close()

	if err := tlsConn.HandshakeContext(ctx); err != nil {
		completedAt := time.Now().UTC()
		result.CompletedAt = completedAt
		result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
		result.ErrorCode = normalizeError(err)
		result.ErrorMessage = safeMessage(err)
		return result
	}

	state := tlsConn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		completedAt := time.Now().UTC()
		result.CompletedAt = completedAt
		result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
		result.ErrorCode = contracts.ErrorTLS
		result.ErrorMessage = "no peer certificates presented"
		return result
	}

	leaf := state.PeerCertificates[0]
	expiresAt := leaf.NotAfter.UTC()
	daysRemaining := int(time.Until(expiresAt).Hours() / 24)

	result.SSL = &contracts.SSLResult{
		ExpiresAt:     expiresAt,
		DaysRemaining: daysRemaining,
	}

	completedAt := time.Now().UTC()
	result.CompletedAt = completedAt
	result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())

	if (job.Config.WarnBeforeDays > 0 && daysRemaining <= job.Config.WarnBeforeDays) || daysRemaining <= 0 {
		result.ErrorCode = contracts.ErrorAssertion
		result.ErrorMessage = fmt.Sprintf("certificate expires in %d days, threshold is %d", daysRemaining, job.Config.WarnBeforeDays)
		return result
	}

	result.Outcome = contracts.OutcomePass
	return result
}
