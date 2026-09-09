package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vune0210/Argus/agents/probe/internal/config"
	"github.com/vune0210/Argus/agents/probe/internal/contracts"
)

func testConfig(base string) config.Config {
	return config.Config{Environment: "test", ControlPlaneURL: base, ProbeID: "test-probe", Region: "test", Token: "argp_test-probe.integration-secret"}
}
func testLease() Lease {
	now := time.Now().UTC()
	return Lease{LeaseID: "11111111-1111-4111-8111-111111111111", ExpiresAt: now.Add(45*time.Second), TargetRegion: "test", Job: contracts.ProbeJob{
		SchemaVersion: "0.1", ExecutionID: "22222222-2222-4222-8222-222222222222", OrganizationID: "33333333-3333-4333-8333-333333333333",
		MonitorID: "44444444-4444-4444-8444-444444444444", MonitorVersion: 1, ScheduledAt: now, DeadlineAt: now.Add(150*time.Second),
		Config: contracts.MonitorConfig{Kind: "http", URL: "https://example.com", Method: "GET", TimeoutMS: 5000, ExpectedStatus: 200, MaxRedirects: 5, MaxResponseBytes: 1048576},
	}}
}
func TestNoContentAndTokenRedaction(t *testing.T) {
	status := atomic.Int32{}; status.Store(204)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer argp_test-probe.integration-secret" { t.Error("missing auth") }
		w.WriteHeader(int(status.Load()))
		if status.Load() != 204 { _, _ = w.Write([]byte("private upstream body argp_test-probe.integration-secret")) }
	}))
	defer server.Close()
	client, err := New(testConfig(server.URL)); if err != nil { t.Fatal(err) }
	lease, err := client.Lease(context.Background()); if err != nil || lease != nil { t.Fatalf("204: %v %v", lease,err) }
	status.Store(401)
	_, err = client.Lease(context.Background())
	if err == nil || Retryable(err) || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private") { t.Fatalf("unsafe error: %v",err) }
}
func TestStrictLeaseValidation(t *testing.T) {
	for _, change := range []func(*Lease){func(l *Lease){l.TargetRegion="wrong"},func(l *Lease){l.ExpiresAt=time.Now().Add(-time.Second)},func(l *Lease){l.LeaseID="../other"},func(l *Lease){l.Job.SchemaVersion="9"}} {
		lease:=testLease();change(&lease)
		server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,_ *http.Request){_ = json.NewEncoder(w).Encode(lease)}))
		client,_:=New(testConfig(server.URL));_,err:=client.Lease(context.Background());server.Close()
		if err==nil || Retryable(err){t.Fatalf("expected permanent lease rejection: %v",err)}
	}
}
func TestRetryClassification(t *testing.T) {
	for _, code:=range []int{400,401,403,404,409,410,422}{if Retryable(&StatusError{code}){t.Errorf("retry permanent %d",code)}}
	for _, code:=range []int{408,429,500,502,503}{if !Retryable(&StatusError{code}){t.Errorf("no retry transient %d",code)}}
	if !Retryable(errors.New("transport unavailable")){t.Error("transport should retry")}
}
func TestProductionRequiresHTTPS(t *testing.T) {
	cfg:=testConfig("http://example.com");cfg.Environment="production"
	if _,err:=New(cfg);err==nil{t.Fatal("accepted cleartext production control plane")}
}
func TestTokenFileRotation(t *testing.T) {
	path:=filepath.Join(t.TempDir(),"token")
	if err:=os.WriteFile(path,[]byte("argp_test-probe.first-secret-value"),0600);err!=nil{t.Fatal(err)}
	var header atomic.Value
	server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){header.Store(r.Header.Get("Authorization"));w.WriteHeader(204)}));defer server.Close()
	cfg:=testConfig(server.URL);cfg.TokenFile=path;client,err:=New(cfg);if err!=nil{t.Fatal(err)}
	_,_=client.Lease(context.Background())
	if header.Load()!="Bearer argp_test-probe.first-secret-value"{t.Fatal("first token missing")}
	if err:=os.WriteFile(path,[]byte("argp_test-probe.second-secret-value"),0600);err!=nil{t.Fatal(err)}
	_,_=client.Lease(context.Background())
	if header.Load()!="Bearer argp_test-probe.second-secret-value"{t.Fatal("rotation not picked up")}
}

type fakePlane struct { leases atomic.Int32; submits atomic.Int32; heartbeats atomic.Int32; accepted chan struct{}; retry bool }
func (f *fakePlane) Lease(ctx context.Context)(*Lease,error){
	if f.leases.Add(1)==1{lease:=testLease();return &lease,nil}
	<-ctx.Done();return nil,ctx.Err()
}
func (f *fakePlane) Heartbeat(context.Context,string)error{f.heartbeats.Add(1);return nil}
func (f *fakePlane) Submit(context.Context,string,contracts.ProbeResult)error{
	if f.submits.Add(1)==1&&f.retry{return &StatusError{503}}
	if f.accepted!=nil{close(f.accepted)}
	return nil
}
func TestGracefulDrain(t *testing.T){
	ctx,cancel:=context.WithCancel(context.Background());defer cancel()
	f:=&fakePlane{accepted:make(chan struct{})}
	started:=make(chan struct{});release:=make(chan struct{});done:=make(chan error,1)
	go func(){done<-Run(ctx,f,2,func(ctx context.Context,job contracts.ProbeJob)contracts.ProbeResult{
		close(started);<-release
		if ctx.Err()!=nil{t.Error("shutdown cancelled active job")}
		return contracts.ProbeResult{}
	})}()
	<-started;cancel();close(release)
	select{case err:=<-done:if err!=nil{t.Fatal(err)};case <-time.After(time.Second):t.Fatal("did not drain")}
	if f.submits.Load()!=1{t.Fatal("active result not submitted")}
}
func TestHeartbeatAndSubmissionRetry(t *testing.T){
	f:=&fakePlane{retry:true};lease:=testLease()
	perform(f,&lease,func(context.Context,contracts.ProbeJob)contracts.ProbeResult{time.Sleep(15*time.Millisecond);return contracts.ProbeResult{}},2*time.Millisecond)
	if f.heartbeats.Load()==0||f.submits.Load()!=2{t.Fatalf("heartbeat/retry missing: %d/%d",f.heartbeats.Load(),f.submits.Load())}
}
