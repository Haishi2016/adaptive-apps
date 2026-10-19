package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"time"
)

type attributes map[string]any

type monitorEvent struct {
	Time       string     `json:"time_iso"`
	Name       string     `json:"name"`
	Attributes attributes `json:"attributes"`
}

type monitorSpan struct {
	TraceID       string         `json:"trace_id"`
	SpanID        string         `json:"span_id"`
	Parent        *string        `json:"parent_span_id"`
	Name          string         `json:"name"`
	Kind          string         `json:"kind"`
	Start         string         `json:"start_time_iso"`
	End           string         `json:"end_time_iso"`
	Duration      float64        `json:"duration_ms"`
	Status        string         `json:"status"`
	StatusMessage *string        `json:"status_message"`
	Service       string         `json:"service"`
	Attributes    attributes     `json:"attributes"`
	Events        []monitorEvent `json:"events"`
}

type nativeTag struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

func tagAttributes(tags []nativeTag) attributes {
	result := attributes{}
	for _, tag := range tags {
		switch tag.Value.(type) {
		case string, float64, bool:
			result[tag.Key] = tag.Value
		}
	}
	return result
}

type jaegerTrace struct {
	TraceID string `json:"traceID"`
	Spans   []struct {
		TraceID    string      `json:"traceID"`
		SpanID     string      `json:"spanID"`
		Operation  string      `json:"operationName"`
		ProcessID  string      `json:"processID"`
		Start      int64       `json:"startTime"`
		Duration   int64       `json:"duration"`
		Tags       []nativeTag `json:"tags"`
		References []struct {
			Type    string `json:"refType"`
			TraceID string `json:"traceID"`
			SpanID  string `json:"spanID"`
		} `json:"references"`
		Logs []struct {
			Timestamp int64       `json:"timestamp"`
			Fields    []nativeTag `json:"fields"`
		} `json:"logs"`
	} `json:"spans"`
	Processes map[string]struct {
		Service string      `json:"serviceName"`
		Tags    []nativeTag `json:"tags"`
	} `json:"processes"`
}

func nativeID(id string, lengths ...int) bool {
	validLength := false
	for _, length := range lengths {
		validLength = validLength || len(id) == length
	}
	if !validLength {
		return false
	}
	for _, c := range id {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func (m *monitorReader) traceRecords(ctx context.Context, services map[string]string, namespace, agent string, now time.Time) ([]monitorRecord, error) {
	records := []monitorRecord{}
	names := make([]string, 0, len(services))
	for service := range services {
		names = append(names, service)
	}
	sort.Strings(names)
	for _, service := range names {
		var response struct {
			Data   *[]jaegerTrace    `json:"data"`
			Errors []json.RawMessage `json:"errors"`
		}
		query := url.Values{"service": {service}, "lookback": {"1h"}, "limit": {"100"},
			"start": {strconv.FormatInt(now.Add(-monitorLookback).UnixMicro(), 10)}, "end": {strconv.FormatInt(now.UnixMicro(), 10)}}
		if err := m.read(ctx, m.traces+"/api/traces", query, &response, "Jaeger"); err != nil {
			return nil, err
		}
		if response.Data == nil || len(response.Errors) != 0 || len(*response.Data) > 100 {
			return nil, unavailable("Jaeger Monitor query failed or exceeded result bound")
		}
		for _, trace := range *response.Data {
			if !nativeID(trace.TraceID, 16, 32) || len(trace.Spans) == 0 {
				return nil, unavailable("Jaeger Monitor native trace is invalid")
			}
			for _, span := range trace.Spans {
				process, exists := trace.Processes[span.ProcessID]
				if !exists || process.Service == "" {
					return nil, unavailable("Jaeger Monitor span has no native process")
				}
				if _, owned := services[process.Service]; !owned {
					continue
				}
				attrs := tagAttributes(process.Tags)
				if name, ok := attrs["adaptive.agent.name"]; ok && name != agent {
					continue
				}
				if ns, ok := attrs["service.namespace"]; ok && ns != namespace {
					continue
				}
				if !nativeID(trace.TraceID, 16, 32) || span.TraceID != trace.TraceID || !nativeID(span.SpanID, 16) ||
					span.Operation == "" || span.Start <= 0 || span.Duration < 0 || span.Duration > int64(monitorLookback/time.Microsecond) {
					return nil, unavailable("Jaeger Monitor native span is invalid")
				}
				for key, value := range tagAttributes(span.Tags) {
					attrs[key] = value
				}
				s := monitorSpan{
					TraceID: span.TraceID, SpanID: span.SpanID, Name: span.Operation, Kind: "internal",
					Start:    time.UnixMicro(span.Start).UTC().Format(time.RFC3339Nano),
					End:      time.UnixMicro(span.Start + span.Duration).UTC().Format(time.RFC3339Nano),
					Duration: float64(span.Duration) / 1000, Status: "unset", Service: process.Service,
					Attributes: attrs, Events: []monitorEvent{},
				}
				if kind, ok := attrs["span.kind"].(string); ok {
					switch kind {
					case "internal", "server", "client", "producer", "consumer":
						s.Kind = kind
					}
				}
				switch attrs["otel.status_code"] {
				case "OK", "ok", float64(1):
					s.Status = "ok"
				case "ERROR", "error", float64(2):
					s.Status = "error"
				}
				if attrs["error"] == true {
					s.Status = "error"
				}
				if message, ok := attrs["otel.status_description"].(string); ok {
					s.StatusMessage = &message
				}
				for _, ref := range span.References {
					if ref.Type == "CHILD_OF" && ref.TraceID == span.TraceID && nativeID(ref.SpanID, 16) {
						parent := ref.SpanID
						s.Parent = &parent
						break
					}
				}
				for _, log := range span.Logs {
					fields := tagAttributes(log.Fields)
					name, _ := fields["event"].(string)
					if name == "" {
						name, _ = fields["event.name"].(string)
					}
					if name == "" || log.Timestamp <= 0 {
						return nil, unavailable("Jaeger Monitor native event is invalid")
					}
					s.Events = append(s.Events, monitorEvent{time.UnixMicro(log.Timestamp).UTC().Format(time.RFC3339Nano), name, fields})
				}
				records = append(records, monitorRecord{"span", "span:" + span.TraceID + ":" + span.SpanID, s})
				if len(records) > monitorRecordLimit {
					return nil, unavailable("Jaeger Monitor result exceeds bounded reader capacity")
				}
			}
		}
	}
	return records, nil
}

func ownsDeployment(services map[string]string, deployment string) bool {
	for _, owned := range services {
		if owned == deployment {
			return true
		}
	}
	return false
}

type monitorLog struct {
	Type       string     `json:"type"`
	ID         string     `json:"log_id"`
	Name       string     `json:"name"`
	TraceID    string     `json:"trace_id"`
	SpanID     string     `json:"span_id"`
	Time       string     `json:"time_iso"`
	Severity   string     `json:"severity"`
	Service    string     `json:"service"`
	Attributes attributes `json:"attributes"`
}

var decisionKeys = map[string]string{
	"guardrail_stage": "guardrail.stage", "guardrail_action": "guardrail.action",
	"guardrail_resource": "guardrail.resource", "guardrail_decision": "guardrail.decision",
	"guardrail_mode": "guardrail.mode", "guardrail_enforced": "guardrail.enforced",
	"guardrail_config_sha256": "guardrail.config_sha256", "guardrail_policy": "guardrail.policy",
	"guardrail_rule": "guardrail.rule", "adaptive_agent_name": "adaptive.agent.name",
	"adaptive_agent_version": "adaptive.agent.version", "adaptive_agent_deployment": "adaptive.agent.deployment",
	"service_namespace": "service.namespace", "agent_id": "agent.id",
}

func (m *monitorReader) logRecords(ctx context.Context, services map[string]string, namespace, agent string, now time.Time) ([]monitorRecord, error) {
	query := fmt.Sprintf(`{service_name="governance-sidecar",service_namespace=%s,adaptive_agent_name=%s} |= "guardrail.decision"`, strconv.Quote(namespace), strconv.Quote(agent))
	var response struct {
		Status string `json:"status"`
		Data   *struct {
			Type   string `json:"resultType"`
			Result []struct {
				Stream map[string]string   `json:"stream"`
				Values [][]json.RawMessage `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := m.read(ctx, m.logs+"/loki/api/v1/query_range", url.Values{
		"query": {query}, "start": {strconv.FormatInt(now.Add(-monitorLookback).UnixNano(), 10)},
		"end": {strconv.FormatInt(now.UnixNano(), 10)}, "limit": {"1000"}, "direction": {"forward"},
	}, &response, "Loki"); err != nil {
		return nil, err
	}
	if response.Status != "success" || response.Data == nil || response.Data.Type != "streams" {
		return nil, unavailable("Loki Monitor query failed")
	}
	records := []monitorRecord{}
	total := 0
	for _, stream := range response.Data.Result {
		for _, value := range stream.Values {
			total++
			if total > 1000 || len(value) < 2 || len(value) > 3 {
				return nil, unavailable("Loki Monitor result invalid or exceeds query bound")
			}
			var timestamp, body string
			if json.Unmarshal(value[0], &timestamp) != nil || json.Unmarshal(value[1], &body) != nil {
				return nil, unavailable("Loki Monitor native log is invalid")
			}
			if body != "guardrail.decision" {
				continue
			}
			metadata := map[string]string{}
			for k, v := range stream.Stream {
				metadata[k] = v
			}
			if len(value) == 3 {
				var structured map[string]string
				if json.Unmarshal(value[2], &structured) != nil {
					return nil, unavailable("Loki Monitor structured metadata is invalid")
				}
				for k, v := range structured {
					metadata[k] = v
				}
			}
			if !ownsDeployment(services, metadata["adaptive_agent_deployment"]) ||
				metadata["adaptive_agent_name"] != agent || metadata["service_namespace"] != namespace ||
				metadata["service_name"] != "governance-sidecar" {
				continue
			}
			stamp, err := strconv.ParseInt(timestamp, 10, 64)
			severity, severityErr := strconv.Atoi(metadata["severity_number"])
			if err != nil || stamp <= 0 || severityErr != nil || severity < 1 || severity > 24 || metadata["guardrail_decision"] == "" {
				return nil, unavailable("Loki Monitor decision metadata is invalid")
			}
			attrs := attributes{}
			for native, dotted := range decisionKeys {
				if v, exists := metadata[native]; exists {
					attrs[dotted] = v
				}
			}
			enforced, err := strconv.ParseBool(metadata["guardrail_enforced"])
			if err != nil {
				return nil, unavailable("Loki Monitor enforced metadata is invalid")
			}
			attrs["guardrail.enforced"] = enforced
			level := "info"
			if severity >= 17 {
				level = "error"
			} else if severity >= 13 {
				level = "warning"
			}
			// Stable identity is derived only from the native timestamp and record.
			identity, _ := json.Marshal([]any{timestamp, body, metadata})
			id := fmt.Sprintf("%x", sha256.Sum256(identity))
			record := monitorLog{"log", id, body, metadata["trace_id"], metadata["span_id"],
				time.Unix(0, stamp).UTC().Format(time.RFC3339Nano), level, "governance-sidecar", attrs}
			records = append(records, monitorRecord{"log", "log:" + id, record})
		}
	}
	return records, nil
}
