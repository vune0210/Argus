package executor

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

func testJob(target string) contracts.ProbeJob {
	return contracts.ProbeJob{
		SchemaVersion:  contracts.SchemaVersion,
		ExecutionID:    "11111111-1111-4111-8111-111111111111",
		OrganizationID: "22222222-2222-4222-8222-222222222222",
		MonitorID:      "33333333-3333-4333-8333-333333333333",
		MonitorVersion: 1,
		ScheduledAt:    time.Now().UTC(),
		DeadlineAt:     time.Now().UTC().Add(time.Minute),
		Config: contracts.MonitorConfig{
			Kind: "http", URL: target, Method: http.MethodGet, TimeoutMS: 500,
			ExpectedStatus: 200, MaxRedirects: 2, MaxResponseBytes: 1024,
		},
	}
}

func TestHTTPExecutorPassesExpectedStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write([]byte("healthy"))
	}))
	defer server.Close()

	executor := HTTPExecutor{ProbeID: "test-probe", Region: "test", AllowPrivateTarget: true}
	result := executor.Execute(context.Background(), testJob(server.URL))
	if result.Outcome != contracts.OutcomePass || result.HTTP == nil || result.HTTP.StatusCode != 200 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestHTTPExecutorReportsAssertionFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	executor := HTTPExecutor{ProbeID: "test-probe", Region: "test", AllowPrivateTarget: true}
	result := executor.Execute(context.Background(), testJob(server.URL))
	if result.ErrorCode != contracts.ErrorAssertion {
		t.Fatalf("expected assertion error, received %+v", result)
	}
}

func TestHTTPExecutorTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	job := testJob(server.URL)
	job.Config.TimeoutMS = 100

	executor := HTTPExecutor{ProbeID: "test-probe", Region: "test", AllowPrivateTarget: true}
	result := executor.Execute(context.Background(), job)
	if result.ErrorCode != contracts.ErrorTimeout {
		t.Fatalf("expected timeout error, received %+v", result)
	}
}

func TestNormalizeDNSError(t *testing.T) {
	if code := normalizeError(&net.DNSError{Name: "missing.invalid", Err: "not found"}); code != contracts.ErrorDNS {
		t.Fatalf("expected DNS error code, received %s", code)
	}
}

func TestHTTPExecutorLimitsResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write(make([]byte, 128))
	}))
	defer server.Close()
	job := testJob(server.URL)
	job.Config.MaxResponseBytes = 16

	executor := HTTPExecutor{ProbeID: "test-probe", Region: "test", AllowPrivateTarget: true}
	result := executor.Execute(context.Background(), job)
	if result.ErrorCode != contracts.ErrorResponseTooLarge {
		t.Fatalf("expected response-too-large error, received %+v", result)
	}
}
