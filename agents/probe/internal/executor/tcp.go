package executor

import (
	"context"
	"net"
	"strconv"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type TCPExecutor struct {
	ProbeID            string
	Region             string
	AllowPrivateTarget bool
}

func (e TCPExecutor) Execute(parent context.Context, job contracts.ProbeJob) contracts.ProbeResult {
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
		timeout = 5 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if !job.DeadlineAt.IsZero() && job.DeadlineAt.Before(deadline) {
		deadline = job.DeadlineAt
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()

	addr := net.JoinHostPort(job.Config.Host, strconv.Itoa(job.Config.Port))
	dialer := guardedDialer(e.AllowPrivateTarget)
	conn, err := dialer(ctx, "tcp", addr)
	completedAt := time.Now().UTC()
	result.CompletedAt = completedAt
	result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())

	if err != nil {
		result.TCP = &contracts.TCPResult{Connected: false}
		result.ErrorCode = normalizeError(err)
		result.ErrorMessage = safeMessage(err)
		return result
	}
	_ = conn.Close()

	result.TCP = &contracts.TCPResult{Connected: true}
	result.Outcome = contracts.OutcomePass
	return result
}
