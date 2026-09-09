// Code generated from the Argus v0.2 JSON Schemas. DO NOT EDIT BY HAND.
package contracts

import "time"

const SchemaVersion = "0.2"

type HTTPMonitorConfig struct {
	Kind             string `json:"kind"`
	URL              string `json:"url"`
	Method           string `json:"method"`
	TimeoutMS        int    `json:"timeoutMs"`
	ExpectedStatus   int    `json:"expectedStatus"`
	MaxRedirects     int    `json:"maxRedirects"`
	MaxResponseBytes int64  `json:"maxResponseBytes"`
}

type TCPMonitorConfig struct {
	Kind      string `json:"kind"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	TimeoutMS int    `json:"timeoutMs"`
}

type SSLMonitorConfig struct {
	Kind           string `json:"kind"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	ServerName     string `json:"serverName,omitempty"`
	TimeoutMS      int    `json:"timeoutMs"`
	WarnBeforeDays int    `json:"warnBeforeDays"`
}

type KeywordMonitorConfig struct {
	Kind             string `json:"kind"`
	URL              string `json:"url"`
	Method           string `json:"method"`
	ExpectedStatus   int    `json:"expectedStatus"`
	Keyword          string `json:"keyword"`
	MatchMode        string `json:"matchMode"`
	CaseSensitive    bool   `json:"caseSensitive"`
	MaxRedirects     int    `json:"maxRedirects"`
	MaxResponseBytes int64  `json:"maxResponseBytes"`
	TimeoutMS        int    `json:"timeoutMs"`
}

type MonitorConfig struct {
	Kind             string `json:"kind"`
	URL              string `json:"url,omitempty"`
	Method           string `json:"method,omitempty"`
	TimeoutMS        int    `json:"timeoutMs"`
	ExpectedStatus   int    `json:"expectedStatus,omitempty"`
	MaxRedirects     int    `json:"maxRedirects,omitempty"`
	MaxResponseBytes int64  `json:"maxResponseBytes,omitempty"`
	Host             string `json:"host,omitempty"`
	Port             int    `json:"port,omitempty"`
	ServerName       string `json:"serverName,omitempty"`
	WarnBeforeDays   int    `json:"warnBeforeDays,omitempty"`
	Keyword          string `json:"keyword,omitempty"`
	MatchMode        string `json:"matchMode,omitempty"`
	CaseSensitive    bool   `json:"caseSensitive,omitempty"`
}

type ProbeJob struct {
	SchemaVersion  string        `json:"schemaVersion"`
	ExecutionID    string        `json:"executionId"`
	OrganizationID string        `json:"organizationId"`
	MonitorID      string        `json:"monitorId"`
	MonitorVersion int           `json:"monitorVersion"`
	ScheduledAt    time.Time     `json:"scheduledAt"`
	DeadlineAt     time.Time     `json:"deadlineAt"`
	Config         MonitorConfig `json:"config"`
}

type HTTPResult struct {
	StatusCode    int   `json:"statusCode"`
	ResponseBytes int64 `json:"responseBytes"`
}

type TCPResult struct {
	Connected bool `json:"connected"`
}

type SSLResult struct {
	ExpiresAt     time.Time `json:"expiresAt"`
	DaysRemaining int       `json:"daysRemaining"`
}

type KeywordResult struct {
	StatusCode    int   `json:"statusCode"`
	ResponseBytes int64 `json:"responseBytes"`
	Matched       bool  `json:"matched"`
}

type ProbeResult struct {
	SchemaVersion  string         `json:"schemaVersion"`
	ExecutionID    string         `json:"executionId"`
	OrganizationID string         `json:"organizationId"`
	MonitorID      string         `json:"monitorId"`
	MonitorVersion int            `json:"monitorVersion"`
	ProbeID        string         `json:"probeId"`
	Region         string         `json:"region"`
	StartedAt      time.Time      `json:"startedAt"`
	CompletedAt    time.Time      `json:"completedAt"`
	DurationMS     int64          `json:"durationMs"`
	Outcome        string         `json:"outcome"`
	ErrorCode      string         `json:"errorCode,omitempty"`
	ErrorMessage   string         `json:"errorMessage,omitempty"`
	HTTP           *HTTPResult    `json:"http,omitempty"`
	TCP            *TCPResult     `json:"tcp,omitempty"`
	SSL            *SSLResult     `json:"ssl,omitempty"`
	Keyword        *KeywordResult `json:"keyword,omitempty"`
}

const (
	OutcomePass = "PASS"
	OutcomeFail = "FAIL"

	ErrorDNS              = "DNS"
	ErrorConnect          = "CONNECT"
	ErrorTimeout          = "TIMEOUT"
	ErrorTLS              = "TLS"
	ErrorAssertion        = "ASSERTION"
	ErrorResponseTooLarge = "RESPONSE_TOO_LARGE"
	ErrorSSRFBlocked      = "SSRF_BLOCKED"
	ErrorInternal         = "INTERNAL"
)
