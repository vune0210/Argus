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

func makeJob(schemaVersion string) contracts.ProbeJob {
	now := time.Now().UTC()
	return contracts.ProbeJob{
		SchemaVersion:  schemaVersion,
		ExecutionID:    "11111111-1111-4111-8111-111111111111",
		OrganizationID: "22222222-2222-4222-8222-222222222222",
		MonitorID:      "33333333-3333-4333-8333-333333333333",
		MonitorVersion: 1,
		ScheduledAt:    now,
		DeadlineAt:     now.Add(time.Minute),
	}
}

func TestTCPExecutor_SuccessAndFailures(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
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

	// 1. Success with AllowPrivateTarget
	execAllow := TCPExecutor{ProbeID: "probe-1", Region: "local", AllowPrivateTarget: true}
	job := makeJob("0.2")
	job.Config = contracts.MonitorConfig{Kind: "tcp", Host: host, Port: port, TimeoutMS: 1000}
	res := execAllow.Execute(context.Background(), job)
	if res.Outcome != contracts.OutcomePass || res.TCP == nil || !res.TCP.Connected {
		t.Fatalf("expected TCP pass, got %+v", res)
	}
	if res.SchemaVersion != "0.2" {
		t.Fatalf("expected schemaVersion 0.2, got %s", res.SchemaVersion)
	}

	// 2. SSRF Blocked with AllowPrivateTarget: false
	execBlock := TCPExecutor{ProbeID: "probe-1", Region: "local", AllowPrivateTarget: false}
	resSSRF := execBlock.Execute(context.Background(), job)
	if resSSRF.Outcome != contracts.OutcomeFail || resSSRF.ErrorCode != contracts.ErrorSSRFBlocked {
		t.Fatalf("expected SSRF_BLOCKED for 127.0.0.1, got %+v", resSSRF)
	}

	// 3. Connection refused
	jobRefused := makeJob("0.2")
	jobRefused.Config = contracts.MonitorConfig{Kind: "tcp", Host: "127.0.0.1", Port: 59999, TimeoutMS: 500}
	resRefused := execAllow.Execute(context.Background(), jobRefused)
	if resRefused.Outcome != contracts.OutcomeFail || resRefused.ErrorCode != contracts.ErrorConnect {
		t.Fatalf("expected CONNECT error, got %+v", resRefused)
	}

	// 4. Backward compatible schema version 0.1
	jobV1 := makeJob("0.1")
	jobV1.Config = contracts.MonitorConfig{Kind: "tcp", Host: host, Port: port, TimeoutMS: 1000}
	resV1 := execAllow.Execute(context.Background(), jobV1)
	if resV1.SchemaVersion != "0.1" {
		t.Fatalf("expected schemaVersion 0.1, got %s", resV1.SchemaVersion)
	}
}

func TestSSLExecutor_SuccessAndFailures(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	host, portStr, _ := net.SplitHostPort(server.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	// 1. SSRF Blocked with AllowPrivateTarget: false
	execBlock := SSLExecutor{ProbeID: "probe-1", Region: "local", AllowPrivateTarget: false}
	job := makeJob("0.2")
	job.Config = contracts.MonitorConfig{Kind: "ssl", Host: host, Port: port, TimeoutMS: 1000}
	resSSRF := execBlock.Execute(context.Background(), job)
	if resSSRF.Outcome != contracts.OutcomeFail || resSSRF.ErrorCode != contracts.ErrorSSRFBlocked {
		t.Fatalf("expected SSRF_BLOCKED, got %+v", resSSRF)
	}

	// 2. TLS Untrusted Cert (self-signed cert without root CA)
	execAllow := SSLExecutor{ProbeID: "probe-1", Region: "local", AllowPrivateTarget: true}
	resTLS := execAllow.Execute(context.Background(), job)
	if resTLS.Outcome != contracts.OutcomeFail || resTLS.ErrorCode != contracts.ErrorTLS {
		t.Fatalf("expected TLS error for self-signed certificate, got %+v", resTLS)
	}
}

func TestKeywordExecutor_Comprehensive(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Service Status: Operational. All green."))
	}))
	defer server.Close()

	exec := KeywordExecutor{ProbeID: "probe-1", Region: "local", AllowPrivateTarget: true}

	// 1. Successful keyword match with GET
	jobPass := makeJob("0.2")
	jobPass.Config = contracts.MonitorConfig{
		Kind:           "keyword",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		Keyword:        "Operational",
		MatchMode:      "CONTAINS",
		CaseSensitive:  true,
		TimeoutMS:      1000,
	}
	resPass := exec.Execute(context.Background(), jobPass)
	if resPass.Outcome != contracts.OutcomePass || resPass.Keyword == nil || !resPass.Keyword.Matched {
		t.Fatalf("expected keyword pass, got %+v", resPass)
	}

	// 2. Successful NOT_CONTAINS mode
	jobNotContains := makeJob("0.2")
	jobNotContains.Config = contracts.MonitorConfig{
		Kind:           "keyword",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		Keyword:        "DatabaseDown",
		MatchMode:      "NOT_CONTAINS",
		TimeoutMS:      1000,
	}
	resNotContains := exec.Execute(context.Background(), jobNotContains)
	if resNotContains.Outcome != contracts.OutcomePass || !resNotContains.Keyword.Matched {
		t.Fatalf("expected NOT_CONTAINS pass, got %+v", resNotContains)
	}

	// 3. Case insensitive match
	jobCase := makeJob("0.2")
	jobCase.Config = contracts.MonitorConfig{
		Kind:           "keyword",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		Keyword:        "operational",
		CaseSensitive:  false,
		TimeoutMS:      1000,
	}
	resCase := exec.Execute(context.Background(), jobCase)
	if resCase.Outcome != contracts.OutcomePass || !resCase.Keyword.Matched {
		t.Fatalf("expected case-insensitive pass, got %+v", resCase)
	}

	// 4. Case sensitive mismatch fails
	jobCaseFail := makeJob("0.2")
	jobCaseFail.Config = contracts.MonitorConfig{
		Kind:           "keyword",
		URL:            server.URL,
		Method:         "GET",
		ExpectedStatus: 200,
		Keyword:        "OPERATIONAL",
		CaseSensitive:  true,
		TimeoutMS:      1000,
	}
	resCaseFail := exec.Execute(context.Background(), jobCaseFail)
	if resCaseFail.Outcome != contracts.OutcomeFail || resCaseFail.ErrorCode != contracts.ErrorAssertion {
		t.Fatalf("expected case-sensitive fail, got %+v", resCaseFail)
	}

	// 5. Unsupported method rejected
	jobPost := makeJob("0.2")
	jobPost.Config = contracts.MonitorConfig{
		Kind:      "keyword",
		URL:       server.URL,
		Method:    "POST",
		Keyword:   "Operational",
		TimeoutMS: 1000,
	}
	resPost := exec.Execute(context.Background(), jobPost)
	if resPost.Outcome != contracts.OutcomeFail || resPost.ErrorCode != contracts.ErrorAssertion {
		t.Fatalf("expected ErrorAssertion for POST method, got %+v", resPost)
	}

	// 6. SSRF Blocked
	execBlock := KeywordExecutor{ProbeID: "probe-1", Region: "local", AllowPrivateTarget: false}
	resSSRF := execBlock.Execute(context.Background(), jobPass)
	if resSSRF.Outcome != contracts.OutcomeFail || resSSRF.ErrorCode != contracts.ErrorSSRFBlocked {
		t.Fatalf("expected SSRF_BLOCKED, got %+v", resSSRF)
	}
}
