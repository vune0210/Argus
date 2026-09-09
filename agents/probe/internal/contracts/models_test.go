package contracts

import (
	"strings"
	"testing"
	"time"
)

func TestDecodeJobRejectsUnknownFields(t *testing.T) {
	payload := `{
		"schemaVersion":"0.1",
		"executionId":"11111111-1111-4111-8111-111111111111",
		"organizationId":"22222222-2222-4222-8222-222222222222",
		"monitorId":"33333333-3333-4333-8333-333333333333",
		"monitorVersion":1,
		"scheduledAt":"2026-09-04T00:00:00Z",
		"deadlineAt":"2026-09-04T00:01:00Z",
		"unexpected":true,
		"config":{"kind":"http","url":"https://example.com","method":"GET","timeoutMs":5000,"expectedStatus":200,"maxRedirects":5,"maxResponseBytes":1024}
	}`
	if _, err := DecodeJob(strings.NewReader(payload)); err == nil {
		t.Fatal("expected unknown field to be rejected")
	}
}

func TestJobRejectsEmbeddedURLCredentials(t *testing.T) {
	job := ProbeJob{
		SchemaVersion:  SchemaVersion,
		ExecutionID:    "11111111-1111-4111-8111-111111111111",
		OrganizationID: "22222222-2222-4222-8222-222222222222",
		MonitorID:      "33333333-3333-4333-8333-333333333333",
		MonitorVersion: 1,
		ScheduledAt:    time.Now().UTC(),
		DeadlineAt:     time.Now().UTC().Add(time.Minute),
		Config:         MonitorConfig{Kind: "http", URL: "https://user:secret@example.com", Method: "GET", TimeoutMS: 5000, ExpectedStatus: 200, MaxRedirects: 5, MaxResponseBytes: 1024},
	}
	if err := job.Validate(); err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("expected embedded credentials error, received %v", err)
	}
}
