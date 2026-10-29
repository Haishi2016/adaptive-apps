package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	ktesting "k8s.io/client-go/testing"
)

// Wire fixtures follow the native Jaeger 1.62 / Loki 3.3 HTTP query contracts.
// They are test records, not evidence of a deployed SDK pipeline.
const jaegerFixture = `{"data":[{
 "traceID":"11111111111111111111111111111111",
 "processes":{"p1":{"serviceName":"azure.ai.agentserver","tags":[
 {"key":"service.namespace","value":"adaptive"},{"key":"adaptive.agent.name","value":"demo"}]}},
 "spans":[
 {"traceID":"11111111111111111111111111111111","spanID":"2222222222222222","processID":"p1","operationName":"invoke_agent demo","startTime":1791547200000000,"duration":1500,"tags":[{"key":"span.kind","value":"server"}],"references":[],"logs":[]},
 {"traceID":"11111111111111111111111111111111","spanID":"3333333333333333","processID":"p1","operationName":"agent_run demo","startTime":1791547200000100,"duration":1200,"tags":[{"key":"otel.status_code","value":"OK"}],"references":[{"refType":"CHILD_OF","traceID":"11111111111111111111111111111111","spanID":"2222222222222222"}],"logs":[]},
 {"traceID":"11111111111111111111111111111111","spanID":"4444444444444444","processID":"p1","operationName":"chat local-chat","startTime":1791547200000200,"duration":500,"tags":[{"key":"span.kind","value":"client"},{"key":"gen_ai.request.model","value":"local-chat"},{"key":"gen_ai.usage.input_tokens","value":7},{"key":"otel.status_code","value":"ERROR"},{"key":"otel.status_description","value":"native status"}],"references":[{"refType":"CHILD_OF","traceID":"11111111111111111111111111111111","spanID":"3333333333333333"}],"logs":[{"timestamp":1791547200000300,"fields":[{"key":"event","value":"native.event"},{"key":"value","value":true}]}]}
 ]}],"errors":null}`

const lokiFixture = `{"status":"success","data":{"resultType":"streams","result":[{
 "stream":{"service_name":"governance-sidecar","service_namespace":"adaptive","adaptive_agent_name":"demo"},
 "values":[["1791547200000300123","guardrail.decision",{
 "adaptive_agent_deployment":"demo-v1","adaptive_agent_version":"v1","trace_id":"11111111111111111111111111111111","span_id":"4444444444444444",
 "severity_number":"13","guardrail_decision":"deny","guardrail_mode":"audit","guardrail_enforced":"false",
 "guardrail_policy":"pii","guardrail_rule":"deny-pii","guardrail_action":"responses","guardrail_resource":"local-chat","guardrail_config_sha256":"actual-config"}],
 ["1791547200000300456","not a guardrail.decision",{}],
 ["1791547200000300789","guardrail.decision",{"adaptive_agent_deployment":"other-agent-v1"}]]
 }]}}`

func nativeStores(t *testing.T, jaeger, loki http.HandlerFunc) *monitorReader {
	t.Helper()
	traces := httptest.NewServer(jaeger)
	t.Cleanup(traces.Close)
	logs := httptest.NewServer(loki)
	t.Cleanup(logs.Close)
	m, err := newMonitorReader(traces.URL, logs.URL)
	if err != nil {
		t.Fatal(err)
	}
	m.poll = 10 * time.Millisecond
	t.Cleanup(m.client.CloseIdleConnections)
	return m
}

func fixtureHandler(t *testing.T, path, body string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path || r.Method != http.MethodGet {
			t.Errorf("unexpected native request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("browser identity forwarded to administrative store")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}
}

func TestNativeStoreFixtureProjection(t *testing.T) {
	var traceCalls, logCalls atomic.Int32
	m := nativeStores(t, func(w http.ResponseWriter, r *http.Request) {
		traceCalls.Add(1)
		q := r.URL.Query()
		if q.Get("service") != nativeTraceService || q.Get("limit") != "100" || q.Get("lookback") != "1h" {
			t.Error("Jaeger query was not bounded or actual release")
		}
		fixtureHandler(t, "/api/traces", jaegerFixture)(w, r)
	}, func(w http.ResponseWriter, r *http.Request) {
		logCalls.Add(1)
		q := r.URL.Query()
		expected := `{service_name="governance-sidecar",service_namespace="adaptive",adaptive_agent_name="demo"} |= "guardrail.decision"`
		if q.Get("query") != expected || q.Get("limit") != "1000" || q.Get("start") == "" || q.Get("end") == "" {
			t.Error("Loki query was not bounded or exact agent")
		}
		fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture)(w, r)
	})
	f := newFixture(t)
	f.api.monitor = m
	r := httptest.NewRequest("GET", "/v1/agents/demo/spans", nil)
	r.SetPathValue("name", "demo")
	r.Header.Set("Authorization", "do-not-copy")
	r.Header.Set("Cookie", "do-not-copy")
	records, err := f.api.monitorRecords(r, m)
	if err != nil || len(records) != 4 {
		t.Fatalf("native projection: %v, %#v", err, records)
	}
	for i, name := range []string{"invoke_agent demo", "agent_run demo", "chat local-chat"} {
		span := records[i].value.(monitorSpan)
		if span.Name != name || span.TraceID != "11111111111111111111111111111111" || span.Service != nativeTraceService {
			t.Fatal("native span identity/name was altered")
		}
		if i > 0 && (span.Parent == nil || *span.Parent != records[i-1].value.(monitorSpan).SpanID) {
			t.Fatal("native parent chain lost")
		}
	}
	chat := records[2].value.(monitorSpan)
	if chat.Duration != 0.5 || chat.Kind != "client" || chat.Status != "error" ||
		chat.StatusMessage == nil || *chat.StatusMessage != "native status" ||
		len(chat.Events) != 1 || chat.Events[0].Name != "native.event" ||
		chat.Start != "2026-10-09T12:00:00.0002Z" || chat.End != "2026-10-09T12:00:00.0007Z" {
		t.Fatalf("native span timing/status/events: %#v", chat)
	}
	log := records[3].value.(monitorLog)
	if log.Type != "log" || log.Name != "guardrail.decision" || log.Severity != "warning" ||
		log.TraceID != chat.TraceID || log.SpanID != chat.SpanID || log.Attributes["guardrail.enforced"] != false ||
		log.Attributes["guardrail.config_sha256"] != "actual-config" || log.Attributes["adaptive.agent.version"] != "v1" ||
		log.Time != "2026-10-09T12:00:00.000300123Z" {
		t.Fatalf("native decision projection: %#v", log)
	}
	again, err := f.api.monitorRecords(r, m)
	if err != nil || again[3].id != records[3].id || traceCalls.Load() != 2 || logCalls.Load() != 2 {
		t.Fatal("native deduplication identity is unstable")
	}
}

func TestMonitorInitialFailuresNeverOpenSSE(t *testing.T) {
	for _, store := range []string{"Jaeger", "Loki"} {
		for _, fault := range []string{"http", "malformed", "nativeError", "oversize"} {
			t.Run(store+"/"+fault, func(t *testing.T) {
				broken := func(w http.ResponseWriter, r *http.Request) {
					switch fault {
					case "http":
						w.WriteHeader(503)
						_, _ = io.WriteString(w, "private upstream body")
					case "malformed":
						_, _ = io.WriteString(w, `{}`)
					case "nativeError":
						_, _ = io.WriteString(w, `{"errors":["private"],"data":[],"status":"error"}`)
					case "oversize":
						_, _ = io.WriteString(w, strings.Repeat(" ", monitorBodyLimit+1))
					}
				}
				traces := fixtureHandler(t, "/api/traces", jaegerFixture)
				logs := fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture)
				if store == "Jaeger" {
					traces = broken
				} else {
					logs = broken
				}
				f := newFixture(t)
				f.api.monitor = nativeStores(t, traces, logs)
				view := request(t, f.api, "GET", "/v1/agents/demo/spans", "", 503)
				if !strings.Contains(view["detail"].(string), store) || strings.Contains(view["detail"].(string), "private") {
					t.Fatal("store failure not explicit and sanitized")
				}
			})
		}
	}
}

func TestMonitorSSEDedupCancellationAndLaterFailure(t *testing.T) {
	for _, laterFailure := range []bool{false, true} {
		t.Run(fmt.Sprint(laterFailure), func(t *testing.T) {
			var calls atomic.Int32
			f := newFixture(t)
			f.api.monitor = nativeStores(t, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) > 1 && laterFailure {
					w.WriteHeader(503)
					return
				}
				fixtureHandler(t, "/api/traces", jaegerFixture)(w, r)
			}, fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture))
			server := httptest.NewServer(f.api.handler())
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/v1/agents/demo/spans", nil)
			response, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
				t.Fatal("stream failed to open")
			}
			scanner := bufio.NewScanner(response.Body)
			count, heartbeats := 0, 0
			for scanner.Scan() {
				line := scanner.Text()
				if strings.HasPrefix(line, "data: ") {
					count++
					var record map[string]any
					if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &record) != nil {
						t.Fatal("invalid SSE JSON")
					}
					if record["type"] == "log" {
						if _, ok := record["attributes"].(map[string]any)["guardrail.enforced"].(bool); !ok {
							t.Fatal("UI log schema requires boolean enforced")
						}
					} else {
						for _, key := range []string{"trace_id", "span_id", "parent_span_id", "name", "kind", "start_time_iso", "end_time_iso", "duration_ms", "status", "status_message", "service", "attributes", "events"} {
							if _, exists := record[key]; !exists {
								t.Fatalf("missing UI span field %s", key)
							}
						}
					}
				}
				if line == ": keepalive" {
					heartbeats++
					if heartbeats == 3 && !laterFailure {
						cancel()
					}
				}
			}
			if count != 4 || calls.Load() < 2 || (laterFailure && heartbeats != 1) {
				t.Fatalf("dedup/EOF failed: records=%d calls=%d heartbeats=%d", count, calls.Load(), heartbeats)
			}
			if laterFailure && scanner.Err() != nil {
				t.Fatalf("expected clean close recognized by UI reconnect, got %v", scanner.Err())
			}
		})
	}
}

func TestMonitorCancelsNativeHTTPReader(t *testing.T) {
	entered, canceled := make(chan struct{}), make(chan struct{})
	f := newFixture(t)
	f.api.monitor = nativeStores(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(canceled)
	}, fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest("GET", "/v1/agents/demo/spans", nil).WithContext(ctx)
		f.api.handler().ServeHTTP(httptest.NewRecorder(), req)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("reader did not start")
	}
	cancel()
	for _, signal := range []chan struct{}{canceled, done} {
		select {
		case <-signal:
		case <-time.After(time.Second):
			t.Fatal("request cancellation did not propagate")
		}
	}
}

func TestMonitorExactOwnershipAndBoundaries(t *testing.T) {
	f := newFixture(t)
	f.api.monitor = nativeStores(t, fixtureHandler(t, "/api/traces", jaegerFixture), fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture))
	request(t, f.api, "GET", "/v1/agents/unknown/spans", "", 404)
	request(t, f.api, "GET", "/v1/agents/demo/spans?version=missing", "", 422)
	request(t, f.api, "GET", "/v1/agents/demo/spans?service=other", "", 422)
	request(t, f.api, "GET", "/v1/agents/demo/spans?backend=http://browser", "", 422)
	request(t, f.api, "GET", "/v1/agents/demo/spans?version=UPPER", "", 422)
	request(t, f.api, "GET", "/v1/agents/demo/spans?version=%", "", 422)
	f.deployment.SetAnnotations(map[string]string{"radius.resource.id": "/other"})
	update(t, f, "statefulsets", f.deployment)
	request(t, f.api, "GET", "/v1/agents/demo/spans", "", 503)
	f.objects.PrependReactor("list", "configmaps", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("private Kubernetes details")
	})
	request(t, f.api, "GET", "/v1/agents/demo/spans", "", 503)
}

func TestMonitorAdministrativeEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{"file:///secret", "http://user:secret@host", "http://host/path", "http://host?query=1", "http://host#fragment", "/relative"} {
		if _, err := newMonitorReader(endpoint, "http://logs:3100"); err == nil {
			t.Fatalf("accepted invalid administrative origin %s", endpoint)
		}
	}
	t.Setenv("TRACE_QUERY_ENDPOINT", "http://traces:16686")
	t.Setenv("LOG_QUERY_ENDPOINT", "http://logs:3100")
	m, err := monitorFromEnvironment()
	if err != nil || m.traces != os.Getenv("TRACE_QUERY_ENDPOINT") || m.logs != os.Getenv("LOG_QUERY_ENDPOINT") {
		t.Fatal("fixed administrative environment bindings ignored")
	}
}

func TestMonitorDoesNotFollowNativeStoreRedirects(t *testing.T) {
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { followed.Store(true) }))
	defer target.Close()
	m := nativeStores(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }, fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture))
	err := m.read(context.Background(), m.traces+"/api/traces", url.Values{}, new(any), "Jaeger")
	if err == nil || followed.Load() {
		t.Fatal("native store redirect escaped fixed administrative origin")
	}
}

func TestMonitorNativeResultBoundsAndDecisionTypes(t *testing.T) {
	for _, test := range []struct {
		name     string
		traces   string
		logs     string
		want     int
		level    string
		enforced bool
	}{
		{"info", jaegerFixture, strings.ReplaceAll(strings.ReplaceAll(lokiFixture, `"severity_number":"13"`, `"severity_number":"9"`), `"guardrail_enforced":"false"`, `"guardrail_enforced":"true"`), 200, "info", true},
		{"error", jaegerFixture, strings.ReplaceAll(lokiFixture, `"severity_number":"13"`, `"severity_number":"17"`), 200, "error", false},
		{"invalidSeverity", jaegerFixture, strings.ReplaceAll(lokiFixture, `"severity_number":"13"`, `"severity_number":"bogus"`), 503, "", false},
		{"invalidEnforced", jaegerFixture, strings.ReplaceAll(lokiFixture, `"guardrail_enforced":"false"`, `"guardrail_enforced":"maybe"`), 503, "", false},
		{"invalidTimestamp", jaegerFixture, strings.ReplaceAll(lokiFixture, `"1791547200000300123"`, `"bad"`), 503, "", false},
		{"invalidSpanID", strings.ReplaceAll(jaegerFixture, `"spanID":"4444444444444444"`, `"spanID":"bad"`), lokiFixture, 503, "", false},
		{"invalidProcess", strings.ReplaceAll(jaegerFixture, `"processID":"p1"`, `"processID":"missing"`), lokiFixture, 503, "", false},
		{"tooManyTraces", `{"data":[` + strings.TrimSuffix(strings.Repeat(`{"spans":[]},`, 101), ",") + `]}`, lokiFixture, 503, "", false},
		{"tooManyLogs", jaegerFixture, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{},"values":[` + strings.TrimSuffix(strings.Repeat(`["1","other"],`, 1001), ",") + `]}]}}`, 503, "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			f.api.monitor = nativeStores(t, fixtureHandler(t, "/api/traces", test.traces), fixtureHandler(t, "/loki/api/v1/query_range", test.logs))
			if test.want != 200 {
				request(t, f.api, "GET", "/v1/agents/demo/spans", "", test.want)
				return
			}
			r := httptest.NewRequest("GET", "/v1/agents/demo/spans", nil)
			r.SetPathValue("name", "demo")
			records, err := f.api.monitorRecords(r, f.api.monitor)
			if err != nil {
				t.Fatal(err)
			}
			log := records[3].value.(monitorLog)
			if log.Severity != test.level || log.Attributes["guardrail.enforced"] != test.enforced {
				t.Fatal("native severity/boolean type mapping lost")
			}
		})
	}
}

func TestMonitorUsesCurrentRuntime(t *testing.T) {
	f := newFixture(t)
	f.api.monitor = nativeStores(t, fixtureHandler(t, "/api/traces", jaegerFixture), fixtureHandler(t, "/loki/api/v1/query_range", lokiFixture))
	r := httptest.NewRequest("GET", "/v1/agents/demo/spans", nil)
	r.SetPathValue("name", "demo")
	_, services, err := f.api.monitorServices(r)
	if err != nil || len(services) != 1 || services[nativeTraceService] != "demo-v1" {
		t.Fatal("monitor did not resolve current native runtime")
	}
	for i := 0; i < cap(f.api.monitor.slots); i++ {
		f.api.monitor.slots <- struct{}{}
	}
	request(t, f.api, "GET", "/v1/agents/demo/spans", "", 503)
	for i := 0; i < cap(f.api.monitor.slots); i++ {
		<-f.api.monitor.slots
	}
}
