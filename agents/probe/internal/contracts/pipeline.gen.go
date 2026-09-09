// Code generated from OpenAPI v0.2. DO NOT EDIT.
package contracts

import "time"

type ProbeLease struct {
	LeaseID      string    `json:"leaseId"`
	ExpiresAt    time.Time `json:"expiresAt"`
	TargetRegion string    `json:"targetRegion"`
	Job          ProbeJob  `json:"job"`
}

type ResultReceipt struct {
	ReceiptID  string    `json:"receiptId"`
	ReceivedAt time.Time `json:"receivedAt"`
	Duplicate  bool      `json:"duplicate"`
}
