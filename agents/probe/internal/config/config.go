package config

import (
	"errors"
	"os"
	"strconv"
)

type Config struct {
	Environment         string
	ControlPlaneURL     string
	ProbeID             string
	Region              string
	Token               string
	TokenFile           string
	Concurrency         int
	AllowPrivateTargets bool
}

func Load() (Config, error) {
	concurrency, err := strconv.Atoi(value("ARGUS_CONCURRENCY", "4"))
	if err != nil || concurrency < 1 || concurrency > 100 {
		return Config{}, errors.New("ARGUS_CONCURRENCY must be an integer between 1 and 100")
	}
	allowPrivate, err := strconv.ParseBool(value("ARGUS_ALLOW_PRIVATE_TARGETS", "false"))
	if err != nil {
		return Config{}, errors.New("ARGUS_ALLOW_PRIVATE_TARGETS must be true or false")
	}
	environment := value("ARGUS_ENV", "development")
	if allowPrivate && environment != "development" && environment != "test" {
		return Config{}, errors.New("private targets are allowed only in development or test")
	}
	return Config{
		Environment:         environment,
		ControlPlaneURL:     value("ARGUS_CONTROL_PLANE_URL", "http://localhost:4000"),
		ProbeID:             value("ARGUS_PROBE_ID", "local-probe"),
		Region:              value("ARGUS_REGION", "local"),
		Token:               os.Getenv("ARGUS_TOKEN"),
		TokenFile:           os.Getenv("ARGUS_TOKEN_FILE"),
		Concurrency:         concurrency,
		AllowPrivateTargets: allowPrivate,
	}, nil
}

func value(name, fallback string) string {
	if current := os.Getenv(name); current != "" {
		return current
	}
	return fallback
}
