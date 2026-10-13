import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import * as api from '../api/client';
import { a365Operation, appendMonitorRecord, MonitorPanel, SpanEvent } from '../components/MonitorPanel';
import { renderWithProviders } from './testUtils';

type MockMonitorStream = {
  signal: AbortSignal;
  emitOpen: () => void;
  emitMessage: (data: string) => void;
  finish: () => void;
  fail: (error: Error) => void;
};
let streams: MockMonitorStream[] = [];

function baseSpan(overrides: Partial<SpanEvent> = {}): SpanEvent {
  return {
    trace_id: '4fa72d3c8c8e4a7c9d2e8f1b3a5c7e9a',
    span_id: '1111111111111111',
    parent_span_id: null,
    name: 'invoke_agent',
    kind: 'server',
    start_time_iso: '2026-06-05T13:31:00.123456Z',
    end_time_iso: '2026-06-05T13:31:00.973456Z',
    duration_ms: 850,
    status: 'ok',
    status_message: null,
    service: 'agentdeployment-trip-scout',
    attributes: {},
    events: [],
    ...overrides,
  };
}

async function mountedSource(): Promise<MockMonitorStream> {
  await waitFor(() => expect(streams).toHaveLength(1));
  return streams[0];
}

describe('MonitorPanel', () => {
  it('includes the native agent_run span in Agent-365 filtering', () => {
    expect(a365Operation(baseSpan({ name: 'agent_run' }))).toBe('agent_run');
  });
  beforeEach(() => {
    streams = [];
    vi.spyOn(api, 'streamAgentSpans').mockImplementation((_name, options) =>
      new Promise<void>((resolve, reject) => {
        streams.push({
          signal: options.signal,
          emitOpen: options.onOpen,
          emitMessage: (data) => options.onEvent({ data }),
          finish: resolve,
          fail: reject,
        });
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    );
  });

  afterEach(() => {
    vi.mocked(api.streamAgentSpans).mockRestore();
    vi.useRealTimers();
  });

  it('renders connecting state initially', () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);

    expect(screen.getByText('Connecting')).toBeInTheDocument();
  });

  it.each(['end', 'disconnect'])('reconnects after stream %s and aborts on unmount', async (reason) => {
    vi.useFakeTimers();
    const { unmount } = renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    await act(async () => {
      if (reason === 'end') streams[0].finish();
      else streams[0].fail(new TypeError('Network disconnected'));
    });
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(streams).toHaveLength(2);
    act(() => streams[1].emitOpen());
    expect(screen.getByText('Live')).toBeInTheDocument();
    unmount();
    expect(streams[1].signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(streams).toHaveLength(2);
  });

  it('does not reconnect after authorization rejection', async () => {
    vi.useFakeTimers();
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    await act(async () => streams[0].fail(new api.ApiError(403, 'Forbidden', null)));
    expect(screen.getByText('Error')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(streams).toHaveLength(1);
  });

  it('keeps repeated guardrail logs distinct from spans and shows audit versus blocking', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();
    act(() => {
      for (const blocked of [true, false]) {
        source.emitMessage(
          JSON.stringify({
            type: 'log',
            log_id: String(blocked),
            name: 'guardrail.decision',
            trace_id: '',
            span_id: '',
            time_iso: '2026-06-05T13:31:00Z',
            severity: 'warning',
            service: 'governance-sidecar',
            attributes: {
              'guardrail.decision': 'deny',
              'guardrail.enforced': blocked,
              'guardrail.action': 'tool',
              'guardrail.resource': 'booking/create_booking',
            },
          }),
        );
      }
      source.emitMessage(JSON.stringify(baseSpan()));
    });
    expect(screen.getByText('Blocked · deny')).toBeInTheDocument();
    expect(screen.getByText('Audit only · deny')).toBeInTheDocument();
    expect(screen.getAllByTitle('guardrail.decision')).toHaveLength(2);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByText('invoke_agent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('No telemetry yet.')).toBeInTheDocument();
  });

  it('accepts span events and shows attribute summaries', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitOpen();
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'call_model',
            kind: 'client',
            duration_ms: 720,
            attributes: {
              'gen_ai.request.model': 'qwen2.5-7b-instruct',
              'gen_ai.usage.input_tokens': 124,
              'gen_ai.usage.output_tokens': 88,
            },
          }),
        ),
      );
    });

    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('call_model')).toBeInTheDocument();
    expect(screen.getByText('model=qwen2.5-7b-instruct · tokens=124→88')).toBeInTheDocument();
    expect(screen.getByText('4fa72d3c')).toBeInTheDocument();
  });

  it('joins guardrail logs with later invocation spans by trace, not conversation ID', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();
    const span = baseSpan({
      attributes: { 'gen_ai.conversation.id': 'conversation-1' },
    });
    act(() => {
      source.emitMessage(
        JSON.stringify({
          type: 'log',
          log_id: 'decision-1',
          name: 'guardrail.decision',
          trace_id: span.trace_id,
          span_id: '2222222222222222',
          time_iso: span.start_time_iso,
          severity: 'info',
          service: 'governance-sidecar',
          attributes: { 'guardrail.decision': 'allow', 'guardrail.enforced': false },
        }),
      );
      source.emitMessage(
        JSON.stringify(baseSpan({ trace_id: 'another-trace', name: 'unrelated invocation' })),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '4fa72d3c' }));
    expect(screen.getByText(/No agent invocation span in the retained telemetry/)).toBeInTheDocument();
    expect(screen.queryByText('unrelated invocation')).not.toBeInTheDocument();
    expect(screen.getByTitle('guardrail.decision')).toBeInTheDocument();
    act(() => source.emitMessage(JSON.stringify(span)));
    expect(screen.getByTitle('invoke_agent')).toBeInTheDocument();
    expect(screen.getByTitle('guardrail.decision')).toBeInTheDocument();
    expect(
      screen.queryByText(/No agent invocation span in the retained telemetry/),
    ).not.toBeInTheDocument();
  });

  it('shows identity transitions as logs, not decisions or spans, and keeps them when filtering traces', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();
    act(() => {
      for (const [mode, result] of [
        ['redButton', 'ready'],
        ['connected', 'pending'],
        ['connected', 'failed'],
      ]) {
        source.emitMessage(
          JSON.stringify({
            type: 'log',
            log_id: `${mode}-${result}`,
            name: 'identity.reconciliation',
            trace_id: '',
            span_id: '',
            time_iso: '2026-10-05T13:31:00Z',
            severity: result === 'failed' ? 'error' : result === 'pending' ? 'warning' : 'info',
            service: 'agent-ingress',
            attributes: {
              'identity.mode': mode,
              'identity.result': result,
              'identity.phase': 'reconcile',
              'identity.entra_state': mode === 'redButton' ? 'deferred' : 'pending',
              'identity.keycloak_state': 'recorded',
              ...(result === 'pending'
                ? { 'identity.pending_reasons': 'arc_oidc_issuer_missing' }
                : {}),
              ...(result === 'failed' ? { 'error.type': 'IdentityProvisioningError' } : {}),
            },
          }),
        );
        if (result === 'pending') {
          source.emitMessage(
            JSON.stringify({
              type: 'log',
              log_id: 'interleaved-guardrail',
              name: 'guardrail.decision',
              trace_id: '',
              span_id: '',
              time_iso: '2026-10-05T13:31:00Z',
              severity: 'info',
              service: 'governance-sidecar',
              attributes: { 'guardrail.decision': 'allow', 'guardrail.enforced': false },
            }),
          );
        }
      }
      source.emitMessage(JSON.stringify(baseSpan()));
    });
    expect(screen.getByText('Telemetry (live)')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Monitor telemetry' });
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(
      screen.queryByRole('table', { name: 'Identity reconciliation' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Guardrail decisions' })).not.toBeInTheDocument();
    expect(
      Array.from(table.querySelectorAll('.monitor-name-cell')).map((cell) => cell.textContent),
    ).toEqual([
      'A365 · invoke_agentinvoke_agent',
      'identity.reconciliation',
      'guardrail.decision',
      'identity.reconciliation',
      'identity.reconciliation',
    ]);
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText(/Keycloak: recorded · arc_oidc_issuer_missing/)).toBeInTheDocument();
    expect(screen.getByText(/Keycloak: recorded · IdentityProvisioningError/)).toBeInTheDocument();
    expect(screen.getByText('Allowed · allow')).toBeInTheDocument();
    expect(screen.getByText('5 records')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '4fa72d3c' }));
    expect(screen.getAllByTitle('identity.reconciliation')).toHaveLength(3);
    expect(screen.queryByTitle('guardrail.decision')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByTitle('identity.reconciliation')[0]);
    expect(screen.getByText('Log details')).toBeInTheDocument();
    expect(screen.getByText('agent-ingress', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize telemetry details' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close telemetry details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('No telemetry yet.')).toBeInTheDocument();
  });

  it('renders raw attributes on a second line that opens span details', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'agent_run',
            attributes: {
              'service.name': 'azure.ai.agentserver',
              'http.status_code': 400,
              model: 'multi-model',
              sampled: true,
            },
          }),
        ),
      );
    });

    const attributesLine = screen.getByText(
      'service.name=azure.ai.agentserver http.status_code=400 model=multi-model sampled=true',
    );
    expect(attributesLine).toBeInTheDocument();

    fireEvent.click(attributesLine);

    expect(screen.getByText('Span details')).toBeInTheDocument();
    expect(screen.getByText('Trace ID')).toBeInTheDocument();
    const resize = screen.getByRole('separator', { name: 'Resize telemetry details' });
    expect(resize).toHaveAttribute('aria-valuenow', '560');
    fireEvent.keyDown(resize, { key: 'ArrowLeft' });
    expect(resize).toHaveAttribute('aria-valuenow', '600');
    fireEvent.keyDown(resize, { key: 'Home' });
    expect(resize).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(resize, { key: 'ArrowRight' });
    expect(resize).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(resize, { key: 'End' });
    expect(resize).toHaveAttribute('aria-valuenow', String(window.innerWidth - 32));
  });

  it('discards paused span events without clearing the existing buffer', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage(JSON.stringify(baseSpan({ name: 'kept-span' })));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => {
      source.emitMessage(
        JSON.stringify(baseSpan({ name: 'discarded-span', span_id: '2222222222222222' })),
      );
    });

    expect(screen.getByText('kept-span')).toBeInTheDocument();
    expect(screen.queryByText('discarded-span')).not.toBeInTheDocument();
  });

  it('clears spans from the table', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage(JSON.stringify(baseSpan({ name: 'clear-me' })));
    });
    expect(screen.getByText('clear-me')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.queryByText('clear-me')).not.toBeInTheDocument();
    expect(screen.getByText('No telemetry yet.')).toBeInTheDocument();
  });

  it('ignores malformed JSON events without crashing', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage('{not-json');
    });

    expect(screen.getByText('No telemetry yet.')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('collapses nested duplicate chat spans from agent-framework and OpenAI instrumentation', () => {
    const child = baseSpan({
      name: 'chat multi-model',
      span_id: '2222222222222222',
      parent_span_id: '1111111111111111',
      kind: 'client',
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.request.model': 'multi-model',
      },
    });
    const parent = baseSpan({
      name: 'chat multi-model',
      span_id: '1111111111111111',
      parent_span_id: 'aaaaaaaaaaaaaaaa',
      kind: 'internal',
      attributes: {
        'gen_ai.provider.name': 'openai',
        'gen_ai.output.messages': '[{"role":"assistant"}]',
      },
    });

    const spans = appendMonitorRecord(appendMonitorRecord([], child), parent);

    expect(spans).toHaveLength(1);
    expect(spans[0].span_id).toBe(parent.span_id);
    expect(spans[0]).toHaveProperty('parent_span_id', parent.parent_span_id);
    expect(spans[0].attributes).toEqual({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'multi-model',
      'gen_ai.provider.name': 'openai',
      'gen_ai.output.messages': '[{"role":"assistant"}]',
    });
    expect(appendMonitorRecord(spans, parent)).toEqual(spans);
  });

  it('keeps separate chat spans that are not a direct parent-child duplicate', () => {
    const first = baseSpan({
      name: 'chat multi-model',
      span_id: '1111111111111111',
      parent_span_id: 'aaaaaaaaaaaaaaaa',
    });
    const second = baseSpan({
      name: 'chat multi-model',
      span_id: '2222222222222222',
      parent_span_id: 'bbbbbbbbbbbbbbbb',
    });

    expect(appendMonitorRecord(appendMonitorRecord([], first), second)).toHaveLength(2);
  });

  it('caps rows at 200 newest spans', async () => {
    const { container } = renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      for (let index = 0; index < 205; index += 1) {
        source.emitMessage(
          JSON.stringify(
            baseSpan({
              name: `span-${index}`,
              span_id: index.toString(16).padStart(16, '0'),
            }),
          ),
        );
      }
    });

    expect(container.querySelectorAll('.monitor-row')).toHaveLength(200);
    expect(screen.getByText('span-204')).toBeInTheDocument();
    expect(screen.queryByText('span-0')).not.toBeInTheDocument();
  });

  it('shares pause, replay deduplication, A365 filtering and retention across logs and spans', async () => {
    const { container } = renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();
    const log = {
      type: 'log',
      log_id: 'identity',
      name: 'identity.reconciliation',
      trace_id: '',
      span_id: '',
      time_iso: '2026-10-05T13:31:00Z',
      severity: 'info',
      service: 'agent-ingress',
      attributes: { 'identity.mode': 'redButton', 'identity.result': 'ready' },
    };
    const emitLog = (): void => source.emitMessage(JSON.stringify(log));
    act(() => {
      emitLog();
      emitLog();
      const span = JSON.stringify(baseSpan({ name: 'original-span' }));
      source.emitMessage(span);
      source.emitMessage(span);
    });
    expect(container.querySelectorAll('.monitor-row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => source.emitMessage(JSON.stringify({ ...log, log_id: 'paused-log' })));
    expect(container.querySelectorAll('.monitor-row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() =>
      source.emitMessage(JSON.stringify(baseSpan({ span_id: 'chat', name: 'chat model' }))),
    );
    fireEvent.click(screen.getByRole('button', { name: /A365 only/ }));
    expect(screen.getByTitle('identity.reconciliation')).toBeInTheDocument();
    expect(screen.getByTitle('chat model')).toBeInTheDocument();
    expect(screen.queryByTitle('original-span')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /A365 only/ }));
    act(() => {
      for (let index = 0; index < 199; index += 1) {
        source.emitMessage(JSON.stringify({ ...log, log_id: `identity-${index}` }));
      }
    });
    expect(container.querySelectorAll('.monitor-row')).toHaveLength(200);
    expect(screen.getByTitle('chat model')).toBeInTheDocument();
    expect(screen.queryByTitle('original-span')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('identity.reconciliation')).toHaveLength(199);
  });

  it('rejects malformed telemetry shapes explicitly', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();
    act(() => source.emitMessage(JSON.stringify({ name: 'broken-span' })));
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('No telemetry yet.')).toBeInTheDocument();
  });

  it('annotates A365 spans with a badge based on gen_ai.operation.name', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'invoke_agent LangGraph',
            attributes: { 'gen_ai.operation.name': 'invoke_agent' },
          }),
        ),
      );
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'chat qwen2.5-7b-instruct',
            span_id: '2222222222222222',
            attributes: { 'gen_ai.operation.name': 'chat' },
          }),
        ),
      );
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'execute_tool check_availability',
            span_id: '3333333333333333',
            attributes: { 'gen_ai.operation.name': 'execute_tool' },
          }),
        ),
      );
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'POST',
            span_id: '4444444444444444',
            attributes: {},
          }),
        ),
      );
    });

    expect(screen.getByText('A365 · invoke_agent')).toBeInTheDocument();
    expect(screen.getByText('A365 · chat')).toBeInTheDocument();
    expect(screen.getByText('A365 · execute_tool')).toBeInTheDocument();
    expect(screen.queryByText(/A365 ·\s*$/)).not.toBeInTheDocument();
  });

  it('falls back to span name prefix when gen_ai.operation.name is missing', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'invoke_agent LangGraph',
            attributes: {},
          }),
        ),
      );
    });

    expect(screen.getByText('A365 · invoke_agent')).toBeInTheDocument();
  });

  it('filters the table to A365 spans only via the toggle', async () => {
    renderWithProviders(<MonitorPanel name="trip-scout" visible />);
    const source = await mountedSource();

    act(() => {
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'chat qwen2.5-7b-instruct',
            attributes: { 'gen_ai.operation.name': 'chat' },
          }),
        ),
      );
      source.emitMessage(
        JSON.stringify(
          baseSpan({
            name: 'should_continue',
            span_id: '2222222222222222',
            attributes: {},
          }),
        ),
      );
    });

    expect(screen.getByText('chat qwen2.5-7b-instruct')).toBeInTheDocument();
    expect(screen.getByText('should_continue')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /A365 only/ }));

    expect(screen.getByText('chat qwen2.5-7b-instruct')).toBeInTheDocument();
    expect(screen.queryByText('should_continue')).not.toBeInTheDocument();
  });
});
