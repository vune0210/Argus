package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/vune0210/Argus/agents/probe/internal/config"
	"github.com/vune0210/Argus/agents/probe/internal/contracts"
	"github.com/vune0210/Argus/agents/probe/internal/controlplane"
	"github.com/vune0210/Argus/agents/probe/internal/executor"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		fatal("usage: argus-probe <version|self-test|execute-file|run> [path]")
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "self-test":
		cfg, err := config.Load()
		if err != nil {
			fatal(err.Error())
		}
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Info("self-test passed", "version", version, "probeId", cfg.ProbeID, "region", cfg.Region)
	case "execute-file":
		if len(os.Args) != 3 {
			fatal("usage: argus-probe execute-file <probe-job.json>")
		}
		if err := executeFile(os.Args[2]); err != nil {
			fatal(err.Error())
		}
	case "run":
		cfg, err := config.Load()
		if err != nil { fatal(err.Error()) }
		client, err := controlplane.New(cfg)
		if err != nil { fatal(err.Error()) }
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		exec := executor.NewDispatcher(cfg.ProbeID, cfg.Region, cfg.AllowPrivateTargets)
		if err := controlplane.Run(ctx, client, cfg.Concurrency, exec.Execute); err != nil { fatal(err.Error()) }
	default:
		fatal("unknown command")
	}
}

func executeFile(path string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open job file: %w", err)
	}
	defer file.Close()
	job, err := contracts.DecodeJob(file)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result := executor.NewDispatcher(cfg.ProbeID, cfg.Region, cfg.AllowPrivateTargets).Execute(ctx, job)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result)
}

func fatal(message string) {
	slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error(message)
	os.Exit(1)
}
