package executor

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type KeywordExecutor struct {
	ProbeID            string
	Region             string
	AllowPrivateTarget bool
}

func (e KeywordExecutor) Execute(parent context.Context, job contracts.ProbeJob) contracts.ProbeResult {
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

	method := strings.ToUpper(job.Config.Method)
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead {
		return e.fail(result, startedAt, contracts.ErrorAssertion, fmt.Errorf("keyword monitor only supports GET and HEAD methods, got %q", method))
	}

	maxBytes := job.Config.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = 1048576
	}

	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           guardedDialer(e.AllowPrivateTarget),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > job.Config.MaxRedirects {
				return errors.New("redirect limit exceeded")
			}
			return nil
		},
	}

	req, err := http.NewRequestWithContext(ctx, method, job.Config.URL, nil)
	if err != nil {
		return e.fail(result, startedAt, contracts.ErrorInternal, err)
	}
	req.Header.Set("User-Agent", "Argus-Probe/0.2")

	resp, err := client.Do(req)
	if err != nil {
		code := normalizeError(err)
		if strings.Contains(err.Error(), "redirect limit exceeded") {
			code = contracts.ErrorAssertion
		}
		return e.fail(result, startedAt, code, err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	readLen := int64(len(bodyBytes))
	if readLen > maxBytes {
		result.Keyword = &contracts.KeywordResult{StatusCode: resp.StatusCode, ResponseBytes: maxBytes, Matched: false}
		return e.fail(result, startedAt, contracts.ErrorResponseTooLarge, errors.New("response exceeded configured byte limit"))
	}
	if err != nil {
		result.Keyword = &contracts.KeywordResult{StatusCode: resp.StatusCode, ResponseBytes: readLen, Matched: false}
		return e.fail(result, startedAt, contracts.ErrorConnect, err)
	}

	if job.Config.ExpectedStatus != 0 && resp.StatusCode != job.Config.ExpectedStatus {
		result.Keyword = &contracts.KeywordResult{StatusCode: resp.StatusCode, ResponseBytes: readLen, Matched: false}
		return e.fail(result, startedAt, contracts.ErrorAssertion, fmt.Errorf("expected HTTP %d, received %d", job.Config.ExpectedStatus, resp.StatusCode))
	}

	bodyText := string(bodyBytes)
	keyword := job.Config.Keyword
	if !job.Config.CaseSensitive {
		bodyText = strings.ToLower(bodyText)
		keyword = strings.ToLower(keyword)
	}

	hasKeyword := strings.Contains(bodyText, keyword)
	mode := strings.ToUpper(job.Config.MatchMode)
	matched := hasKeyword
	if mode == "NOT_CONTAINS" {
		matched = !hasKeyword
	}

	result.Keyword = &contracts.KeywordResult{
		StatusCode:    resp.StatusCode,
		ResponseBytes: readLen,
		Matched:       matched,
	}

	if !matched {
		completedAt := time.Now().UTC()
		result.CompletedAt = completedAt
		result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
		result.ErrorCode = contracts.ErrorAssertion
		result.ErrorMessage = fmt.Sprintf("keyword assertion failed: mode %s keyword %q", mode, job.Config.Keyword)
		return result
	}

	completedAt := time.Now().UTC()
	result.CompletedAt = completedAt
	result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
	result.Outcome = contracts.OutcomePass
	return result
}

func (e KeywordExecutor) fail(result contracts.ProbeResult, startedAt time.Time, code string, err error) contracts.ProbeResult {
	completedAt := time.Now().UTC()
	result.CompletedAt = completedAt
	result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
	result.ErrorCode = code
	result.ErrorMessage = safeMessage(err)
	return result
}
