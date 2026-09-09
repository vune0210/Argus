package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func DecodeJob(reader io.Reader) (ProbeJob, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var job ProbeJob
	if err := decoder.Decode(&job); err != nil {
		return ProbeJob{}, fmt.Errorf("decode ProbeJob: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ProbeJob{}, errors.New("decode ProbeJob: multiple JSON values are not allowed")
	}
	if err := job.Validate(); err != nil {
		return ProbeJob{}, err
	}
	return job, nil
}

func (job ProbeJob) Validate() error {
	if job.SchemaVersion != "0.1" && job.SchemaVersion != "0.2" {
		return fmt.Errorf("unsupported schemaVersion %q", job.SchemaVersion)
	}
	if !uuidPattern.MatchString(job.ExecutionID) || !uuidPattern.MatchString(job.OrganizationID) || !uuidPattern.MatchString(job.MonitorID) || job.MonitorVersion < 1 {
		return errors.New("executionId, organizationId, monitorId, and a positive monitorVersion are required")
	}
	if job.ScheduledAt.IsZero() || job.DeadlineAt.IsZero() || !job.DeadlineAt.After(job.ScheduledAt) {
		return errors.New("scheduledAt and a later deadlineAt are required")
	}
	config := job.Config
	switch config.Kind {
	case "tcp":
		if config.Host == "" {
			return errors.New("config.host is required for tcp monitor")
		}
		if config.Port < 1 || config.Port > 65535 {
			return errors.New("config.port must be between 1 and 65535")
		}
		if config.TimeoutMS < 100 || config.TimeoutMS > 30_000 {
			return errors.New("config.timeoutMs must be between 100 and 30000")
		}
	case "ssl":
		if config.Host == "" {
			return errors.New("config.host is required for ssl monitor")
		}
		if config.Port < 0 || config.Port > 65535 {
			return errors.New("config.port must be between 0 and 65535")
		}
		if config.TimeoutMS < 100 || config.TimeoutMS > 30_000 {
			return errors.New("config.timeoutMs must be between 100 and 30000")
		}
	case "keyword":
		parsed, err := url.ParseRequestURI(config.URL)
		if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return errors.New("config.url must be an absolute HTTP or HTTPS URL")
		}
		if parsed.User != nil {
			return errors.New("config.url must not contain embedded credentials")
		}
		if config.Keyword == "" {
			return errors.New("config.keyword is required for keyword monitor")
		}
		if config.TimeoutMS < 100 || config.TimeoutMS > 30_000 {
			return errors.New("config.timeoutMs must be between 100 and 30000")
		}
	case "", "http":
		parsed, err := url.ParseRequestURI(config.URL)
		if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return errors.New("config.url must be an absolute HTTP or HTTPS URL")
		}
		if parsed.User != nil {
			return errors.New("config.url must not contain embedded credentials")
		}
		allowedMethods := map[string]bool{"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}
		if !allowedMethods[config.Method] {
			return fmt.Errorf("unsupported HTTP method %q", config.Method)
		}
		if config.TimeoutMS < 100 || config.TimeoutMS > 30_000 {
			return errors.New("config.timeoutMs must be between 100 and 30000")
		}
		if config.ExpectedStatus < 100 || config.ExpectedStatus > 599 {
			return errors.New("config.expectedStatus must be between 100 and 599")
		}
		if config.MaxRedirects < 0 || config.MaxRedirects > 10 {
			return errors.New("config.maxRedirects must be between 0 and 10")
		}
		if config.MaxResponseBytes < 1 || config.MaxResponseBytes > 1_048_576 {
			return errors.New("config.maxResponseBytes must be between 1 and 1048576")
		}
	default:
		return fmt.Errorf("unsupported monitor kind %q", config.Kind)
	}
	return nil
}
