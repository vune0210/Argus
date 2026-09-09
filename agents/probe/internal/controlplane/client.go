package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/config"
	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type Lease = contracts.ProbeLease
type Receipt = contracts.ResultReceipt

type StatusError struct { Status int }
func (e *StatusError) Error() string { return fmt.Sprintf("control plane HTTP %d", e.Status) }
func Retryable(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) { return false }
	var status *StatusError
	if errors.As(err, &status) { return status.Status == 408 || status.Status == 429 || status.Status >= 500 }
	var permanent *ProtocolError
	return !errors.As(err, &permanent)
}
type ProtocolError struct { message string }
func (e *ProtocolError) Error() string { return e.message }

type Client struct {
	base string
	region string
	probeID string
	token func() (string, error)
	http *http.Client
}
func New(cfg config.Config) (*Client, error) {
	u, err := url.Parse(cfg.ControlPlaneURL)
	local := cfg.Environment == "development" || cfg.Environment == "test"
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(local && u.Scheme == "http")) {
		return nil, errors.New("control plane must use HTTPS (HTTP allowed only in development/test)")
	}
	token := func() (string, error) {
		value := cfg.Token
		if cfg.TokenFile != "" {
			data, err := os.ReadFile(cfg.TokenFile)
			if err != nil { return "", &ProtocolError{"cannot read probe token file"} }
			value = strings.TrimSpace(string(data))
		}
		if !strings.HasPrefix(value, "argp_"+cfg.ProbeID+".") || len(strings.TrimPrefix(value, "argp_"+cfg.ProbeID+".")) < 16 || strings.ContainsAny(value, "\r\n ") {
			return "", &ProtocolError{"invalid probe token configuration"}
		}
		return value, nil
	}
	if _, err := token(); err != nil { return nil, err }
	return &Client{base: strings.TrimRight(cfg.ControlPlaneURL, "/"), region: cfg.Region, probeID: cfg.ProbeID, token: token,
		http: &http.Client{Timeout: 28*time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) post(ctx context.Context, path string, input, output any) (int, error) {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil { return 0, &ProtocolError{"cannot encode request"} }
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, body)
	if err != nil { return 0, &ProtocolError{"invalid control plane request"} }
	token, err := c.token()
	if err != nil { return 0, err }
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil { return 0, ctx.Err() }
		return 0, errors.New("control plane transport unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent { return response.StatusCode, nil }
	if response.StatusCode != http.StatusOK { return response.StatusCode, &StatusError{response.StatusCode} }
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil { return response.StatusCode, &ProtocolError{"invalid control plane response"} }
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) { return response.StatusCode, &ProtocolError{"invalid control plane response framing"} }
	return response.StatusCode, nil
}
func (c *Client) Lease(ctx context.Context) (*Lease, error) {
	var lease Lease
	status, err := c.post(ctx, "/api/v1/probe-leases", nil, &lease)
	if err != nil { return nil, err }
	if status == http.StatusNoContent { return nil, nil }
	if err := lease.Job.Validate(); err != nil { return nil, &ProtocolError{"invalid leased job"} }
	now := time.Now()
	if !validUUID(lease.LeaseID) || lease.TargetRegion != c.region || !lease.ExpiresAt.After(now) || lease.ExpiresAt.After(lease.Job.DeadlineAt) || !lease.Job.DeadlineAt.After(now) {
		return nil, &ProtocolError{"invalid lease identity, region or deadline"}
	}
	return &lease, nil
}
func validUUID(value string) bool {
	if len(value) != 36 { return false }
	for i, r := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 { if r != '-' { return false }; continue }
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') { return false }
	}
	return true
}
func (c *Client) Heartbeat(ctx context.Context, leaseID string) error {
	var response struct { ExpiresAt time.Time `json:"expiresAt"` }
	_, err := c.post(ctx, "/api/v1/probe-leases/"+leaseID+"/heartbeat", nil, &response)
	if err == nil && !response.ExpiresAt.After(time.Now()) { return &ProtocolError{"invalid heartbeat expiry"} }
	return err
}
func (c *Client) Submit(ctx context.Context, leaseID string, result contracts.ProbeResult) error {
	var receipt Receipt
	_, err := c.post(ctx, "/api/v1/probe-leases/"+leaseID+"/result", result, &receipt)
	if err == nil && (!validUUID(receipt.ReceiptID) || receipt.ReceivedAt.IsZero()) { return &ProtocolError{"invalid result receipt"} }
	return err
}
