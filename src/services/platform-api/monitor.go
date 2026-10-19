package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	monitorLookback    = time.Hour
	monitorBodyLimit   = 4 << 20
	monitorRecordLimit = 4096
	monitorSeenLimit   = 16384
	nativeTraceService = "azure.ai.agentserver"
)

type monitorReader struct {
	client   *http.Client
	traces   string
	logs     string
	poll     time.Duration
	lifetime time.Duration
	slots    chan struct{}
}

func newMonitorReader(traces, logs string) (*monitorReader, error) {
	for _, endpoint := range []string{traces, logs} {
		u, err := url.Parse(endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
			u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return nil, fmt.Errorf("Monitor endpoints must be fixed administrative HTTP origins")
		}
	}
	return &monitorReader{
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				DialContext:       (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				ForceAttemptHTTP2: true, MaxIdleConns: 32, MaxIdleConnsPerHost: 16, MaxConnsPerHost: 16,
				IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 5 * time.Second,
				ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 16 << 10,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		traces: strings.TrimRight(traces, "/"), logs: strings.TrimRight(logs, "/"),
		poll: 5 * time.Second, lifetime: 15 * time.Minute, slots: make(chan struct{}, 16),
	}, nil
}

func monitorFromEnvironment() (*monitorReader, error) {
	traces, logs := os.Getenv("TRACE_QUERY_ENDPOINT"), os.Getenv("LOG_QUERY_ENDPOINT")
	if traces == "" {
		traces = "http://adaptive-traces.adaptive.svc.cluster.local:16686"
	}
	if logs == "" {
		logs = "http://adaptive-logs.adaptive.svc.cluster.local:3100"
	}
	return newMonitorReader(traces, logs)
}

func (m *monitorReader) read(ctx context.Context, endpoint string, query url.Values, result any, store string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+query.Encode(), nil)
	if err != nil {
		return unavailable(store + " Monitor query unavailable")
	}
	request.Header.Set("Accept", "application/json")
	response, err := m.client.Do(request)
	if err != nil {
		return unavailable(store + " Monitor query unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return unavailable(store + " Monitor query unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, monitorBodyLimit+1))
	if err != nil || len(body) > monitorBodyLimit || json.Unmarshal(body, result) != nil {
		return unavailable(store + " Monitor response invalid or exceeds bounded reader capacity")
	}
	return nil
}

type monitorRecord struct {
	event string
	id    string
	value any
}

func (a *API) monitorServices(r *http.Request) (string, map[string]string, error) {
	name, err := selection(r)
	if err != nil {
		return "", nil, err
	}
	agent, err := a.agent(r, name)
	if err != nil {
		return "", nil, err
	}
	runtime, err := a.runtime(r, agent)
	if err != nil {
		return "", nil, err
	}
	if runtime.deployment == nil || text(agent, "data", "agentUid") == "" || agent.GetDeletionTimestamp() != nil {
		return "", nil, failure{http.StatusConflict, "Agent has no verified runtime service to monitor"}
	}
	return name, map[string]string{nativeTraceService: runtime.deployment.GetName()}, nil
}

func (a *API) monitorRecords(r *http.Request, m *monitorReader) ([]monitorRecord, error) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	name, services, err := a.monitorServices(r)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	records, err := m.traceRecords(r.Context(), services, a.namespace, name, now)
	if err != nil {
		return nil, err
	}
	logs, err := m.logRecords(r.Context(), services, a.namespace, name, now)
	if err != nil {
		return nil, err
	}
	if len(records)+len(logs) > monitorRecordLimit {
		return nil, unavailable("Monitor result exceeds bounded reader capacity")
	}
	return append(records, logs...), nil
}

func (a *API) agentSpans(w http.ResponseWriter, r *http.Request) {
	m := a.monitor
	if m == nil {
		respond(func(*http.Request) (any, error) { return nil, unavailable("Monitor readers are not configured") })(w, r)
		return
	}
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	default:
		respond(func(*http.Request) (any, error) {
			return nil, failure{http.StatusServiceUnavailable, "Monitor concurrent stream bound exceeded"}
		})(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), m.lifetime)
	defer cancel()
	r = r.WithContext(ctx)
	records, err := a.monitorRecords(r, m)
	if err != nil {
		respond(func(*http.Request) (any, error) { return nil, err })(w, r)
		return
	}
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	seen := map[string]bool{}
	ticker := time.NewTicker(m.poll)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		for _, record := range records {
			if seen[record.id] {
				continue
			}
			if len(seen) >= monitorSeenLimit {
				return // EOF causes the authenticated UI to reconnect, with a new bounded window.
			}
			body, err := json.Marshal(record.value)
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", record.event, body); err != nil {
				return
			}
			seen[record.id] = true
		}
		if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil || controller.Flush() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		records, err = a.monitorRecords(r, m)
		if err != nil {
			// The existing UI treats EOF as a failed connection and reconnects;
			// that attempt gets the initial HTTP error, never an empty success.
			return
		}
	}
}
