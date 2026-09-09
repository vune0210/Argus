package controlplane

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

type ControlPlane interface {
	Lease(context.Context) (*Lease, error)
	Heartbeat(context.Context, string) error
	Submit(context.Context, string, contracts.ProbeResult) error
}
type Execute func(context.Context, contracts.ProbeJob) contracts.ProbeResult

func pause(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select { case <-ctx.Done(): return false; case <-timer.C: return true }
}
func jitter(attempt int) time.Duration {
	return time.Duration(250+rand.IntN(250)) * time.Millisecond * time.Duration(1<<min(attempt, 4))
}

// Run cancels polling on shutdown, while in-flight checks drain within the job deadline.
func Run(ctx context.Context, client ControlPlane, concurrency int, execute Execute) error {
	if concurrency < 1 || concurrency > 100 { return errors.New("concurrency must be between 1 and 100") }
	poll, stop := context.WithCancel(ctx)
	defer stop()
	errorsCh := make(chan error, concurrency)
	var workers sync.WaitGroup
	for i:=0; i<concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			attempt := 0
			for poll.Err() == nil {
				lease, err := client.Lease(poll)
				if err != nil {
					if poll.Err() != nil { return }
					if !Retryable(err) { errorsCh <- err; stop(); return }
					if !pause(poll, jitter(attempt)) { return }; attempt++; continue
				}
				attempt = 0
				if lease == nil { if !pause(poll, jitter(0)) { return }; continue }
				// A lease accepted just before cancellation is still drained.
				perform(client, lease, execute, 10*time.Second)
			}
		}()
	}
	workers.Wait()
	select { case err := <-errorsCh: return err; default: return nil }
}

func perform(client ControlPlane, lease *Lease, execute Execute, heartbeatInterval time.Duration) {
	ctx, cancel := context.WithDeadline(context.Background(), lease.Job.DeadlineAt)
	defer cancel()
	var heartbeat sync.WaitGroup
	heartbeat.Add(1)
	go func() {
		defer heartbeat.Done()
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done(): return
			case <-ticker.C:
				request, stop := context.WithTimeout(ctx, 5*time.Second)
				err := client.Heartbeat(request, lease.LeaseID)
				stop()
				if err != nil {
					var status *StatusError
					if errors.As(err, &status) && !Retryable(err) { cancel(); return }
				}
			}
		}
	}()
	result := execute(ctx, lease.Job)
	for attempt := 0; ctx.Err() == nil && attempt < 8; attempt++ {
		request, stop := context.WithTimeout(ctx, 10*time.Second)
		err := client.Submit(request, lease.LeaseID, result)
		stop()
		if err == nil { break }
		if !Retryable(err) && !errors.Is(err, context.DeadlineExceeded) { break }
		if !pause(ctx, jitter(attempt)) { break }
	}
	cancel()
	heartbeat.Wait()
}
