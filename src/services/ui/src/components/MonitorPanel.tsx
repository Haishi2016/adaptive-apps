import {
  Badge,
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Text,
  ToggleButton,
} from '@fluentui/react-components';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, streamAgentSpans } from '../api/client';

const AttributesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
type SpanAttributes = z.infer<typeof AttributesSchema>;

const MonitorLogSchema = z.object({
  type: z.literal('log'),
  log_id: z.string(),
  name: z.enum(['guardrail.decision', 'identity.reconciliation']),
  trace_id: z.string(),
  span_id: z.string(),
  time_iso: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  service: z.string(),
  attributes: AttributesSchema,
});
type MonitorLog = z.infer<typeof MonitorLogSchema>;

const SpanSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['internal', 'server', 'client', 'producer', 'consumer']),
  start_time_iso: z.string(),
  end_time_iso: z.string(),
  duration_ms: z.number(),
  status: z.enum(['unset', 'ok', 'error']),
  status_message: z.string().nullable(),
  service: z.string(),
  attributes: AttributesSchema,
  events: z.array(
    z.object({ time_iso: z.string(), name: z.string(), attributes: AttributesSchema }),
  ),
});
export type SpanEvent = z.infer<typeof SpanSchema>;
type MonitorRecord = MonitorLog | SpanEvent;

function isLog(record: MonitorRecord): record is MonitorLog {
  return 'type' in record;
}

export type MonitorPanelProps = {
  name: string;
  visible: boolean;
};

type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

const maxRecords = 200;

function connectionLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting';
    case 'live':
      return 'Live';
    case 'reconnecting':
      return 'Reconnecting';
    case 'error':
      return 'Error';
  }
}

function connectionColor(status: ConnectionStatus): 'subtle' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'live':
      return 'success';
    case 'reconnecting':
      return 'warning';
    case 'error':
      return 'danger';
    case 'connecting':
      return 'subtle';
  }
}

function spanStatusColor(status: SpanEvent['status']): 'subtle' | 'success' | 'danger' {
  switch (status) {
    case 'ok':
      return 'success';
    case 'error':
      return 'danger';
    case 'unset':
      return 'subtle';
  }
}

export type A365Operation = 'invoke_agent' | 'agent_run' | 'chat' | 'execute_tool';

const A365_OPS: ReadonlySet<string> = new Set(['invoke_agent', 'agent_run', 'chat', 'execute_tool']);

export function a365Operation(span: SpanEvent): A365Operation | null {
  const op = span.attributes['gen_ai.operation.name'];
  if (typeof op === 'string') {
    if (A365_OPS.has(op)) {
      return op as A365Operation;
    }
  }
  const firstToken = span.name.split(' ', 1)[0];
  if (A365_OPS.has(firstToken)) {
    return firstToken as A365Operation;
  }
  return null;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDuration(durationMs: number): string {
  return `${durationMs.toFixed(3)} ms`;
}

function tracePrefix(traceId: string): string {
  return traceId.slice(0, 8);
}

export function summarizeAttributes(attrs: SpanAttributes): string {
  const parts: string[] = [];
  if (attrs['gen_ai.request.model']) {
    parts.push(`model=${attrs['gen_ai.request.model']}`);
  }
  if (
    attrs['gen_ai.usage.input_tokens'] !== undefined ||
    attrs['gen_ai.usage.output_tokens'] !== undefined
  ) {
    parts.push(
      `tokens=${attrs['gen_ai.usage.input_tokens'] ?? '?'}→${attrs['gen_ai.usage.output_tokens'] ?? '?'}`,
    );
  }
  if (attrs['http.route']) {
    parts.push(`${attrs['http.request.method'] ?? ''} ${attrs['http.route']}`.trim());
  }
  if (attrs['tool.name']) {
    parts.push(`tool=${attrs['tool.name']}`);
  }
  return parts.join(' · ');
}

export function formatAttributesLine(attrs: SpanAttributes): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

function areParentChildDuplicates(left: SpanEvent, right: SpanEvent): boolean {
  if (left.trace_id !== right.trace_id || left.name !== right.name) {
    return false;
  }
  return left.parent_span_id === right.span_id || right.parent_span_id === left.span_id;
}

function mergeDuplicateSpans(existing: SpanEvent, incoming: SpanEvent): SpanEvent {
  const incomingIsParent = existing.parent_span_id === incoming.span_id;
  const existingIsParent = incoming.parent_span_id === existing.span_id;
  const displaySpan = incomingIsParent || !existingIsParent ? incoming : existing;
  const detailSpan = displaySpan === incoming ? existing : incoming;

  return {
    ...displaySpan,
    attributes: {
      ...detailSpan.attributes,
      ...displaySpan.attributes,
    },
    events: [...displaySpan.events, ...detailSpan.events],
  };
}

export function appendMonitorRecord(
  current: MonitorRecord[],
  incoming: MonitorRecord,
): MonitorRecord[] {
  const duplicateIndex = current.findIndex((record) => {
    if (isLog(incoming)) {
      return isLog(record) && record.log_id === incoming.log_id;
    }
    return (
      !isLog(record) &&
      ((record.trace_id === incoming.trace_id && record.span_id === incoming.span_id) ||
        areParentChildDuplicates(record, incoming))
    );
  });
  if (duplicateIndex === -1) {
    return [incoming, ...current].slice(0, maxRecords);
  }

  const existing = current[duplicateIndex];
  if (isLog(existing) || isLog(incoming) || existing.span_id === incoming.span_id) {
    return current;
  }
  const next = [...current];
  next[duplicateIndex] = mergeDuplicateSpans(existing, incoming);
  return next;
}

function logResult(record: MonitorLog): { label: string; color: 'danger' | 'success' | 'warning' } {
  const identity = record.name === 'identity.reconciliation';
  const result = String(
    record.attributes[identity ? 'identity.result' : 'guardrail.decision'] ?? 'unknown',
  );
  const blocked = record.attributes['guardrail.enforced'] === true;
  const successful = identity ? result === 'ready' : result === 'allow';
  const failed = identity ? result === 'failed' : blocked;
  return {
    label: identity
      ? result
      : `${blocked ? 'Blocked' : successful ? 'Allowed' : 'Audit only'} · ${result}`,
    color: failed ? 'danger' : successful ? 'success' : 'warning',
  };
}

function logSummary(record: MonitorLog): string {
  const attrs = record.attributes;
  return record.name === 'identity.reconciliation'
    ? [
        `${attrs['identity.mode'] ?? 'unknown'} / ${attrs['identity.phase'] ?? ''}`,
        `Entra: ${attrs['identity.entra_state'] ?? 'unknown'}`,
        `Keycloak: ${attrs['identity.keycloak_state'] ?? 'unknown'}`,
        attrs['identity.pending_reasons'],
        attrs['error.type'],
      ]
        .filter(Boolean)
        .join(' · ')
    : `${attrs['guardrail.action'] ?? ''} ${attrs['guardrail.resource'] ?? ''} · ${attrs['guardrail.policy'] ?? '—'} / ${attrs['guardrail.rule'] ?? '—'}`;
}

export function MonitorPanel({ name, visible }: MonitorPanelProps): JSX.Element {
  const [records, setRecords] = useState<MonitorRecord[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [paused, setPaused] = useState(false);
  const [traceFilter, setTraceFilter] = useState<string | null>(null);
  const [a365Only, setA365Only] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<MonitorRecord | null>(null);
  const [detailsWidth, setDetailsWidth] = useState(560);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    setRecords([]);
    setTraceFilter(null);
    setA365Only(false);
    setSelectedRecord(null);
    setStatus('connecting');

    if (!name) {
      setStatus('error');
      return undefined;
    }

    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const receive = (event: { data: string }): void => {
      if (controller.signal.aborted) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        setStatus('error');
        return;
      }

      if (pausedRef.current) {
        return;
      }

      const record =
        parsed && typeof parsed === 'object' && 'type' in parsed
          ? MonitorLogSchema.safeParse(parsed)
          : SpanSchema.safeParse(parsed);
      if (!record.success) {
        setStatus('error');
        return;
      }
      setRecords((current) => appendMonitorRecord(current, record.data));
    };

    const connect = async (): Promise<void> => {
      try {
        await streamAgentSpans(name, {
          signal: controller.signal,
          onOpen: () => setStatus('live'),
          onEvent: receive,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status < 500) {
          setStatus('error');
          return;
        }
      }
      if (!controller.signal.aborted) {
        setStatus('reconnecting');
        retry = setTimeout(() => void connect(), 3000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [name]);

  const displayedRecords = useMemo(() => {
    let list = records;
    if (traceFilter) {
      list = list.filter(
        (record) => record.name === 'identity.reconciliation' || record.trace_id === traceFilter,
      );
    }
    if (a365Only) {
      list = list.filter((record) => isLog(record) || a365Operation(record) !== null);
    }
    return list;
  }, [records, traceFilter, a365Only]);

  const a365Count = useMemo(
    () => records.filter((record) => !isLog(record) && a365Operation(record) !== null).length,
    [records],
  );

  const clear = (): void => {
    setRecords([]);
    setTraceFilter(null);
    setA365Only(false);
    setSelectedRecord(null);
  };

  const resizeDetails = (width: number): void => {
    setDetailsWidth(Math.max(280, Math.min(window.innerWidth - 32, width)));
  };

  return (
    <section className="monitor-panel" aria-label="Agent monitor" data-visible={visible}>
      <div className="monitor-header">
        <Text weight="semibold">Telemetry (live)</Text>
        <Badge appearance="tint" color={connectionColor(status)}>
          {connectionLabel(status)}
        </Badge>
        <ToggleButton checked={paused} onClick={() => setPaused((current) => !current)}>
          Pause
        </ToggleButton>
        <ToggleButton
          checked={a365Only}
          onClick={() => setA365Only((current) => !current)}
          title="Filter spans to Agent-365 operations; keep logs visible"
        >
          A365 only ({a365Count})
        </ToggleButton>
        <Button onClick={clear}>Clear</Button>
        <Text className="muted-text">{records.length} records</Text>
        <Text className="muted-text">Best-effort live telemetry</Text>
        {traceFilter ? (
          <Button appearance="transparent" onClick={() => setTraceFilter(null)}>
            Trace {tracePrefix(traceFilter)} ×
          </Button>
        ) : null}
      </div>

      {traceFilter &&
      !records.some(
        (record) =>
          !isLog(record) &&
          record.trace_id === traceFilter &&
          a365Operation(record) === 'invoke_agent',
      ) ? (
        <Text className="muted-text" role="status">
          No agent invocation span in the retained telemetry for this trace. It may still be
          running, missing instrumentation, or outside the live buffer. A trace ID is not a
          conversation ID.
        </Text>
      ) : null}

      <div className="monitor-table-wrap">
        <table className="monitor-table" aria-label="Monitor telemetry">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event / source</th>
              <th scope="col" className="monitor-duration">
                Duration
              </th>
              <th scope="col">Status</th>
              <th scope="col">Trace</th>
              <th scope="col">Summary</th>
            </tr>
          </thead>
          <tbody>
            {displayedRecords.length > 0 ? (
              displayedRecords.map((record) => {
                const log = isLog(record);
                const summary = log ? logSummary(record) : summarizeAttributes(record.attributes);
                const attributesLine = formatAttributesLine(record.attributes);
                const a365Op = log ? null : a365Operation(record);
                const result = log
                  ? logResult(record)
                  : { label: record.status, color: spanStatusColor(record.status) };
                const openDetails = (): void => setSelectedRecord(record);
                return (
                  <Fragment key={log ? record.log_id : `${record.trace_id}-${record.span_id}`}>
                    <tr
                      className="monitor-row"
                      data-record-type={log ? 'log' : 'span'}
                      data-a365={a365Op ? 'true' : undefined}
                      tabIndex={0}
                      onClick={openDetails}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openDetails();
                        }
                      }}
                    >
                      <td className="monitor-mono">
                        {formatTime(log ? record.time_iso : record.start_time_iso)}
                      </td>
                      <td>
                        <span className="monitor-name-cell">
                          {a365Op ? (
                            <Badge
                              appearance="filled"
                              color="brand"
                              size="small"
                              className="monitor-a365-mark"
                              title={`Agent-365 span (gen_ai.operation.name=${a365Op})`}
                            >
                              A365 · {a365Op}
                            </Badge>
                          ) : null}
                          <span title={record.name}>{record.name}</span>
                        </span>
                        <div className="muted-text">
                          {log ? 'Log' : 'Span'} · {record.service}
                        </div>
                      </td>
                      <td className="monitor-duration monitor-mono">
                        {log ? '—' : formatDuration(record.duration_ms)}
                      </td>
                      <td>
                        <Badge appearance="tint" color={result.color}>
                          {result.label}
                        </Badge>
                      </td>
                      <td>
                        {record.trace_id && !/^0+$/.test(record.trace_id) ? (
                          <button
                            type="button"
                            className="monitor-trace monitor-mono"
                            onClick={(event) => {
                              event.stopPropagation();
                              setTraceFilter(record.trace_id);
                            }}
                          >
                            {tracePrefix(record.trace_id)}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="monitor-summary" title={summary}>
                        {summary || '—'}
                      </td>
                    </tr>
                    <tr className="monitor-attributes-row" onClick={openDetails}>
                      <td colSpan={6}>
                        <div
                          className="monitor-attributes-line monitor-mono"
                          title={attributesLine}
                        >
                          {attributesLine || '—'}
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} className="monitor-empty">
                  No telemetry yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <OverlayDrawer
        className="monitor-drawer"
        style={{ width: detailsWidth, maxWidth: 'calc(100vw - 32px)' }}
        open={Boolean(selectedRecord)}
        position="end"
        onOpenChange={(_, data) => {
          if (!data.open) {
            setSelectedRecord(null);
          }
        }}
      >
        {selectedRecord ? (
          <>
            <div
              className="monitor-resize-handle"
              role="separator"
              aria-label="Resize telemetry details"
              aria-orientation="vertical"
              aria-valuemin={280}
              aria-valuemax={Math.max(280, window.innerWidth - 32)}
              aria-valuenow={Math.min(detailsWidth, window.innerWidth - 32)}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button === 0) {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.preventDefault();
                }
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  resizeDetails(window.innerWidth - event.clientX);
                }
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onKeyDown={(event) => {
                const widths: Record<string, number> = {
                  ArrowLeft: Math.min(detailsWidth, window.innerWidth - 32) + 40,
                  ArrowRight: Math.min(detailsWidth, window.innerWidth - 32) - 40,
                  Home: 280,
                  End: window.innerWidth - 32,
                };
                if (event.key in widths) {
                  event.preventDefault();
                  resizeDetails(widths[event.key]);
                }
              }}
            />
            <DrawerHeader>
              <DrawerHeaderTitle
                action={
                  <Button
                    appearance="subtle"
                    aria-label="Close telemetry details"
                    onClick={() => setSelectedRecord(null)}
                  >
                    ×
                  </Button>
                }
              >
                {isLog(selectedRecord) ? 'Log details' : 'Span details'}
              </DrawerHeaderTitle>
            </DrawerHeader>
            <DrawerBody>
              <div className="monitor-detail">
                <Text as="h3" size={500} weight="semibold">
                  {selectedRecord.name}
                </Text>
                {(() => {
                  const op = isLog(selectedRecord) ? null : a365Operation(selectedRecord);
                  return op ? (
                    <Badge
                      appearance="filled"
                      color="brand"
                      size="medium"
                      className="monitor-a365-mark"
                    >
                      Agent-365 · {op}
                    </Badge>
                  ) : null;
                })()}
                <dl className="monitor-detail-list">
                  <dt>Trace ID</dt>
                  <dd className="monitor-mono">{selectedRecord.trace_id || '—'}</dd>
                  <dt>Span ID</dt>
                  <dd className="monitor-mono">{selectedRecord.span_id || '—'}</dd>
                  <dt>Service</dt>
                  <dd>{selectedRecord.service}</dd>
                  {isLog(selectedRecord) ? (
                    <>
                      <dt>Log ID</dt>
                      <dd className="monitor-mono">{selectedRecord.log_id}</dd>
                      <dt>Time</dt>
                      <dd>{selectedRecord.time_iso}</dd>
                      <dt>Severity</dt>
                      <dd>{selectedRecord.severity}</dd>
                      <dt>Result</dt>
                      <dd>{logResult(selectedRecord).label}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Parent span</dt>
                      <dd className="monitor-mono">{selectedRecord.parent_span_id ?? '—'}</dd>
                      <dt>Kind</dt>
                      <dd>{selectedRecord.kind}</dd>
                      <dt>Duration</dt>
                      <dd>{formatDuration(selectedRecord.duration_ms)}</dd>
                      <dt>Status</dt>
                      <dd>{selectedRecord.status_message ?? selectedRecord.status}</dd>
                    </>
                  )}
                </dl>

                <Text weight="semibold">Attributes</Text>
                <pre className="json-block">
                  {JSON.stringify(selectedRecord.attributes, null, 2)}
                </pre>

                {!isLog(selectedRecord) ? (
                  <>
                    <Text weight="semibold">Events</Text>
                    {selectedRecord.events.length > 0 ? (
                      <ul className="monitor-event-list">
                        {selectedRecord.events.map((spanEvent, index) => (
                          <li key={`${spanEvent.time_iso}-${spanEvent.name}-${index}`}>
                            <Text weight="semibold">
                              <span className="monitor-mono">{formatTime(spanEvent.time_iso)}</span>{' '}
                              {spanEvent.name}
                            </Text>
                            <pre className="json-block">
                              {JSON.stringify(spanEvent.attributes, null, 2)}
                            </pre>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <Text className="muted-text">No events.</Text>
                    )}
                  </>
                ) : null}
              </div>
            </DrawerBody>
          </>
        ) : null}
      </OverlayDrawer>
    </section>
  );
}
