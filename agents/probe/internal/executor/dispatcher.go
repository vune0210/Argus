package executor

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type Executor interface {
	Execute(ctx context.Context, job contracts.ProbeJob) contracts.ProbeResult
}

type Dispatcher struct {
	ProbeID            string
	Region             string
	AllowPrivateTarget bool
	http               HTTPExecutor
	tcp                TCPExecutor
	ssl                SSLExecutor
	keyword            KeywordExecutor
}

func NewDispatcher(probeID, region string, allowPrivateTarget bool) *Dispatcher {
	return &Dispatcher{
		ProbeID:            probeID,
		Region:             region,
		AllowPrivateTarget: allowPrivateTarget,
		http:               HTTPExecutor{ProbeID: probeID, Region: region, AllowPrivateTarget: allowPrivateTarget},
		tcp:                TCPExecutor{ProbeID: probeID, Region: region, AllowPrivateTarget: allowPrivateTarget},
		ssl:                SSLExecutor{ProbeID: probeID, Region: region, AllowPrivateTarget: allowPrivateTarget},
		keyword:            KeywordExecutor{ProbeID: probeID, Region: region, AllowPrivateTarget: allowPrivateTarget},
	}
}

func (d *Dispatcher) Execute(ctx context.Context, job contracts.ProbeJob) contracts.ProbeResult {
	switch strings.ToLower(job.Config.Kind) {
	case "tcp":
		return d.tcp.Execute(ctx, job)
	case "ssl":
		return d.ssl.Execute(ctx, job)
	case "keyword":
		return d.keyword.Execute(ctx, job)
	case "", "http":
		return d.http.Execute(ctx, job)
	default:
		startedAt := time.Now().UTC()
		return contracts.ProbeResult{
			SchemaVersion:  contracts.SchemaVersion,
			ExecutionID:    job.ExecutionID,
			OrganizationID: job.OrganizationID,
			MonitorID:      job.MonitorID,
			MonitorVersion: job.MonitorVersion,
			ProbeID:        d.ProbeID,
			Region:         d.Region,
			StartedAt:      startedAt,
			CompletedAt:    startedAt,
			Outcome:        contracts.OutcomeFail,
			ErrorCode:      contracts.ErrorAssertion,
			ErrorMessage:   fmt.Sprintf("unsupported monitor kind: %s", job.Config.Kind),
		}
	}
}
