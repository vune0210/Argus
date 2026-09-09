package executor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type HTTPExecutor struct {
	ProbeID            string
	Region             string
	AllowPrivateTarget bool
}

func (executor HTTPExecutor) Execute(parent context.Context, job contracts.ProbeJob) contracts.ProbeResult {
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
		ProbeID:        executor.ProbeID,
		Region:         executor.Region,
		StartedAt:      startedAt,
		Outcome:        contracts.OutcomeFail,
	}

	requestDeadline := time.Now().Add(time.Duration(job.Config.TimeoutMS) * time.Millisecond)
	if !job.DeadlineAt.IsZero() && job.DeadlineAt.Before(requestDeadline) {
		requestDeadline = job.DeadlineAt
	}
	ctx, cancel := context.WithDeadline(parent, requestDeadline)
	defer cancel()

	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           guardedDialer(executor.AllowPrivateTarget),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: time.Duration(job.Config.TimeoutMS) * time.Millisecond,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   time.Duration(job.Config.TimeoutMS) * time.Millisecond,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > job.Config.MaxRedirects {
				return errors.New("redirect limit exceeded")
			}
			return nil
		},
	}

	request, err := http.NewRequestWithContext(ctx, job.Config.Method, job.Config.URL, nil)
	if err != nil {
		return executor.fail(result, startedAt, contracts.ErrorInternal, err)
	}
	request.Header.Set("User-Agent", "Argus-Probe/0.1")
	response, err := client.Do(request)
	if err != nil {
		code := normalizeError(err)
		if strings.Contains(err.Error(), "redirect limit exceeded") {
			code = contracts.ErrorAssertion
		}
		return executor.fail(result, startedAt, code, err)
	}
	defer response.Body.Close()

	maxBytes := job.Config.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = 1048576
	}
	read, err := io.Copy(io.Discard, io.LimitReader(response.Body, maxBytes+1))
	result.HTTP = &contracts.HTTPResult{StatusCode: response.StatusCode, ResponseBytes: read}
	if err != nil {
		return executor.fail(result, startedAt, contracts.ErrorConnect, err)
	}
	if read > maxBytes {
		return executor.fail(result, startedAt, contracts.ErrorResponseTooLarge, errors.New("response exceeded configured byte limit"))
	}
	if response.StatusCode != job.Config.ExpectedStatus {
		return executor.fail(result, startedAt, contracts.ErrorAssertion, fmt.Errorf("expected HTTP %d, received %d", job.Config.ExpectedStatus, response.StatusCode))
	}

	completedAt := time.Now().UTC()
	result.CompletedAt = completedAt
	result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
	result.Outcome = contracts.OutcomePass
	return result
}

func (executor HTTPExecutor) fail(result contracts.ProbeResult, startedAt time.Time, code string, err error) contracts.ProbeResult {
	completedAt := time.Now().UTC()
	result.CompletedAt = completedAt
	result.DurationMS = max(0, completedAt.Sub(startedAt).Milliseconds())
	result.ErrorCode = code
	result.ErrorMessage = safeMessage(err)
	return result
}

func safeMessage(err error) string {
	message := err.Error()
	if len(message) > 500 {
		return message[:500]
	}
	return message
}

func normalizeError(err error) string {
	var blocked *SSRFError
	if errors.As(err, &blocked) {
		return contracts.ErrorSSRFBlocked
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return contracts.ErrorTimeout
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return contracts.ErrorTimeout
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return contracts.ErrorDNS
	}
	var certificateError x509.CertificateInvalidError
	var hostnameError x509.HostnameError
	var authorityError x509.UnknownAuthorityError
	if errors.As(err, &certificateError) || errors.As(err, &hostnameError) || errors.As(err, &authorityError) {
		return contracts.ErrorTLS
	}
	var urlError *url.Error
	if errors.As(err, &urlError) && urlError.Timeout() {
		return contracts.ErrorTimeout
	}
	return contracts.ErrorConnect
}
