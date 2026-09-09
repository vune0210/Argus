package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestSharedThreeRegionFixtures(t *testing.T) {
	path := os.Getenv("ARGUS_CONTRACT_FIXTURE")
	if path == "" {
		path = "../../../../packages/contracts/examples/week3-three-region.json"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Leases  []ProbeLease  `json:"leases"`
		Results []ProbeResult `json:"results"`
		Receipt ResultReceipt `json:"receipt"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Leases) != 3 || len(fixture.Results) != 3 {
		t.Fatal("expected exactly three regional leases/results")
	}
	regions := map[string]bool{}
	for i, lease := range fixture.Leases {
		encoded, err := json.Marshal(lease.Job)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeJob(bytes.NewReader(encoded)); err != nil {
			t.Fatal(err)
		}
		result := fixture.Results[i]
		if lease.Job.ExecutionID != fixture.Leases[0].Job.ExecutionID || result.ExecutionID != lease.Job.ExecutionID || result.Region != lease.TargetRegion || result.OrganizationID != lease.Job.OrganizationID || result.MonitorID != lease.Job.MonitorID || result.MonitorVersion != lease.Job.MonitorVersion {
			t.Fatal("producer/consumer fixture identity mismatch")
		}
		if regions[result.Region] {
			t.Fatal("duplicate regional vote")
		}
		regions[result.Region] = true
	}
	if fixture.Receipt.ReceiptID == "" || fixture.Receipt.ReceivedAt.IsZero() || fixture.Receipt.Duplicate {
		t.Fatal("invalid durable receipt fixture")
	}
}
