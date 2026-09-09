package executor

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

func baseJob() contracts.ProbeJob {
	now := time.Now().UTC()
	return contracts.ProbeJob{
		SchemaVersion:  contracts.SchemaVersion,
		ExecutionID:    "11111111-1111-4111-8111-111111111111",
		OrganizationID: "22222222-2222-4222-8222-222222222222",
		MonitorID:      "33333333-3333-4333-8333-333333333333",
		MonitorVersion: 1,
		ScheduledAt:    now,
		DeadlineAt:     now.Add(time.Minute),
	}
}

func TestDispatcherRoutesHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	d := NewDispatcher("probe-1", "test-region", true)
	job := baseJob()
	job.Config = contracts.MonitorConfig{
		Kind:           "http",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		TimeoutMS:      1000,
	}

	res := d.Execute(context.Background(), job)
	if res.Outcome != contracts.OutcomePass || res.HTTP == nil || res.HTTP.StatusCode != 200 {
		t.Fatalf("expected HTTP pass, got %+v", res)
	}
}

func TestDispatcherRoutesTCP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen error: %v", err)
	}
	defer listener.Close()

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	host, portStr, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	d := NewDispatcher("probe-1", "test-region", true)
	job := baseJob()
	job.Config = contracts.MonitorConfig{
		Kind:      "tcp",
		Host:      host,
		Port:      port,
		TimeoutMS: 1000,
	}

	res := d.Execute(context.Background(), job)
	if res.Outcome != contracts.OutcomePass || res.TCP == nil || !res.TCP.Connected {
		t.Fatalf("expected TCP pass, got %+v", res)
	}
}

func TestDispatcherRoutesSSL(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	host, portStr, _ := net.SplitHostPort(server.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	d := NewDispatcher("probe-1", "test-region", true)
	job := baseJob()
	job.Config = contracts.MonitorConfig{
		Kind:           "ssl",
		Host:           host,
		Port:           port,
		ServerName:     "example.com",
		TimeoutMS:      1000,
		WarnBeforeDays: 1,
	}

	res := d.Execute(context.Background(), job)
	// httptest server cert is self-signed, so it fails TLS verification which validates normalizeError(err) == contracts.ErrorTLS
	if res.Outcome != contracts.OutcomeFail || res.ErrorCode != contracts.ErrorTLS {
		t.Fatalf("expected TLS error for self-signed cert without custom CA, got %+v", res)
	}
}

func TestDispatcherRoutesKeyword(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("System Status: All systems operational"))
	}))
	defer server.Close()

	d := NewDispatcher("probe-1", "test-region", true)

	// Matching keyword
	jobPass := baseJob()
	jobPass.Config = contracts.MonitorConfig{
		Kind:           "keyword",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		Keyword:        "operational",
		MatchMode:      "CONTAINS",
		TimeoutMS:      1000,
	}
	resPass := d.Execute(context.Background(), jobPass)
	if resPass.Outcome != contracts.OutcomePass || resPass.Keyword == nil || !resPass.Keyword.Matched {
		t.Fatalf("expected keyword pass, got %+v", resPass)
	}

	// Missing keyword
	jobFail := baseJob()
	jobFail.Config = contracts.MonitorConfig{
		Kind:           "keyword",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		Keyword:        "database outage",
		MatchMode:      "CONTAINS",
		TimeoutMS:      1000,
	}
	resFail := d.Execute(context.Background(), jobFail)
	if resFail.Outcome != contracts.OutcomeFail || resFail.ErrorCode != contracts.ErrorAssertion {
		t.Fatalf("expected keyword assertion fail, got %+v", resFail)
	}
}

func TestDispatcherRejectsUnknownKind(t *testing.T) {
	d := NewDispatcher("probe-1", "test-region", true)
	job := baseJob()
	job.Config = contracts.MonitorConfig{
		Kind: "grpc",
	}
	res := d.Execute(context.Background(), job)
	if res.Outcome != contracts.OutcomeFail || res.ErrorCode != contracts.ErrorAssertion {
		t.Fatalf("expected assertion failure for unknown kind, got %+v", res)
	}
}
