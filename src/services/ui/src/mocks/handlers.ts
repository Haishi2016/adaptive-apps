import { delay, http, HttpResponse } from 'msw';
import { Agent, ToolCatalogEntry, Model, Environment } from '../api/client';

type MutableAgent = Agent & {
  instructions?: string;
  model?: string;
  image?: string;
  port?: number;
};

type SpanAttributeValue = string | number | boolean;

type MockSpanEvent = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  start_time_iso: string;
  end_time_iso: string;
  duration_ms: number;
  status: 'unset' | 'ok' | 'error';
  status_message: string | null;
  service: string;
  attributes: Record<string, SpanAttributeValue>;
  events: Array<{ time_iso: string; name: string; attributes: Record<string, SpanAttributeValue> }>;
};

const mockFoundryProjectEndpoint = 'https://mock-resource.services.ai.azure.com/api/projects/default-edge';

let faultEnabled: boolean;
let models: Model[];
let agents: MutableAgent[];
let tools: ToolCatalogEntry[];

function epoch(date: string): number {
  return Math.floor(new Date(date).getTime() / 1000);
}

export function resetMockData(): void {
  faultEnabled = false;
  models = [
    {
      id: 'qwen2.5-7b-instruct',
      object: 'model',
      provider: 'huggingface',
      kind: 'single',
      status: 'Ready',
      created: epoch('2026-05-20T13:56:27Z'),
      owned_by: 'adaptive',
    },
    {
      id: 'gpt-5.4-mini',
      object: 'model',
      provider: 'foundry',
      kind: 'single',
      status: 'Ready',
      created: epoch('2026-05-20T13:56:57Z'),
      owned_by: 'adaptive',
    },
  ];
  agents = [
    {
      name: 'handoff-service',
      type: 'prompt',
      endpoint: '/agents/handoff-service/responses',
      created: epoch('2026-05-20T14:22:05Z'),
      description: 'Zava Handoff Service Agent',
      model: 'gpt-5.4-mini',
      instructions: 'You are an intent classifier for Zava shopping assistant.',
      identity: {
        entraClientId: '11111111-2222-3333-4444-555555555555',
        blueprintId: 'bp-handoff-service',
        keycloakClientId: 'kc-handoff-service',
      },
      phase: 'Ready',
    },
    {
      name: 'trip-scout',
      type: 'hosted',
      endpoint: '/agents/trip-scout/responses',
      created: epoch('2026-05-20T14:21:58Z'),
      description: 'Portable hosted travel agent',
      image: 'adaptiveghcracr1.azurecr.io/adaptive/trip-scout:dev',
      port: 8080,
      identity: {
        entraClientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        blueprintId: 'bp-trip-scout',
        keycloakClientId: 'kc-trip-scout',
      },
      phase: 'Ready',
    },
  ];
  tools = [
    {
      name: 'skills',
      kind: 'skills',
      displayName: 'Agent Skills',
      description: 'Instruction-only SKILL.md deployment inputs, loaded on demand.',
    },
    {
      name: 'generic-mcp',
      kind: 'mcp',
      displayName: 'Generic MCP',
      description: 'An MCP server configured by the prompt agent definition.',
      authType: 'none',
      identityModes: [],
      executionIdentity: 'caller',
    },
  ];
}

resetMockData();

function streamEvents(events: unknown[], waitMs = 20): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const event of events) {
        const data = typeof event === 'string' ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        await delay(waitMs);
      }
      controller.close();
    },
  });
}

function sseResponse(events: unknown[]) {
  return new HttpResponse(streamEvents(events), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

function sampleSpan(
  agentName: string,
  spanName: string,
  kind: MockSpanEvent['kind'],
  durationMs: number,
  attributes: Record<string, SpanAttributeValue>,
  index: number,
): MockSpanEvent {
  const now = Date.now();
  const end = now - index * 25;
  return {
    trace_id: '4fa72d3c8c8e4a7c9d2e8f1b3a5c7e9a',
    span_id: (index + 1).toString(16).padStart(16, '0'),
    parent_span_id: index === 0 ? null : '0000000000000001',
    name: spanName,
    kind,
    start_time_iso: new Date(end - durationMs).toISOString(),
    end_time_iso: new Date(end).toISOString(),
    duration_ms: durationMs,
    status: 'ok',
    status_message: null,
    service: `agentdeployment-${agentName}`,
    attributes,
    events: index === 0 ? [{ time_iso: new Date(end - 50).toISOString(), name: 'prompt_received', attributes: { agent: agentName } }] : [],
  };
}

function findAgent(name: string): MutableAgent | undefined {
  return agents.find((agent) => agent.name === name);
}

function connectivityFaultResponse() {
  return { enabled: faultEnabled, policyName: 'demo-cloud-egress', namespace: 'adaptive' };
}

function environmentResponse(): Environment {
  return {
    name: 'default-edge',
    description: 'Mock Adaptive edge environment',
    cloud: {
      enabled: true,
      foundryProjectEndpoint: mockFoundryProjectEndpoint,
      foundryProjectArmId: '/subscriptions/mock/resourceGroups/adaptive/providers/Microsoft.MachineLearningServices/workspaces/mock/projects/default-edge',
    },
  };
}

export const handlers = [
  http.get('*/v1/guardrails', () => HttpResponse.json({
    enabled: false, mode: null, policies: [],
  })),
  http.get('*/v1/agents/:name/guardrails', ({ params }) => {
    const agent = findAgent(String(params.name));
    return agent ? HttpResponse.json({
      name: agent.name, enabled: false, mode: null,
      inherited: [], attached: null, policy_sha256: null, deployment: null, phase: null,
    }) : HttpResponse.json({ detail: 'Agent not found' }, { status: 404 });
  }),
  http.get('*/healthz', () => HttpResponse.json({ status: 'ok' })),
  http.get('*/v1/connectivity-fault', () => HttpResponse.json(connectivityFaultResponse())),
  http.patch('*/v1/connectivity-fault', async ({ request }) => {
    const body = (await request.json()) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return HttpResponse.json({ code: 'ValidationError', message: 'Invalid fault setting' }, { status: 422 });
    }
    faultEnabled = body.enabled;
    return HttpResponse.json(connectivityFaultResponse());
  }),
  http.get('*/models/v1/models', () => HttpResponse.json({ object: 'list', data: models })),
  http.get('*/v1/environment', () => HttpResponse.json(environmentResponse())),
  http.get('*/v1/agents', () => HttpResponse.json({
    object: 'list', data: agents,
  })),
  http.get('*/v1/agents/:name', ({ params }) => {
    const agent = findAgent(String(params.name));
    return agent ? HttpResponse.json(agent)
      : HttpResponse.json({ code: 'not_found', message: 'Agent not found' }, { status: 404 });
  }),
  http.get('*/v1/tools', () => HttpResponse.json({ object: 'list', data: tools })),
  http.get('*/v1/agents/:name/agent-card', ({ params }) => {
    const name = String(params.name);
    return HttpResponse.json({
      enabled: true,
      declared: {
        name,
        description: `${name} card`,
        version: '0.1.0',
        capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
          { id: 'planning', name: 'Planning', description: 'Plans trips.', tags: ['travel'] },
        ],
      },
      resolved: {
        name,
        description: `${name} card`,
        version: '0.1.0',
        url: `https://edge.example/.well-known/agents/${name}/agent-card.json`,
      },
      observedCardHash: 'sha256:mock-hash',
      resolvedCardHash: 'sha256:mock-hash',
      audience: `api://${name}`,
      cardUrl: `https://edge.example/.well-known/agents/${name}/agent-card.json`,
      a2aBaseUrl: `https://edge.example/v1/agents/${name}/a2a`,
      connectionString: `https://edge.example/v1/agents/${name}/a2a?api-version=1.0&agent_id=${name}`,
      allowedCallers: [{ kind: 'adaptiveAgent', agentId: 'booking-manager' }],
      peers: [
        {
          name: 'foundry-research',
          cardUrl: 'https://foundry.example/agents/research/agentCard/v1.0',
          a2aBaseUrl: 'https://foundry.example/agents/research/a2a',
          audience: 'api://research',
          protocolVersion: '1.0',
          protocolBinding: 'JSONRPC',
          auth: 'agentIdentity',
          ready: true,
        },
      ],
      blueprintConsentPending: false,
    });
  }),
  http.post('*/v1/agents/:name/agent-card/validate', () =>
    HttpResponse.json({ valid: true, live: 'fetched', differences: [] }),
  ),
  http.post('*/v1/agents/:name/a2a/test-call', async ({ request }) => {
    const body = (await request.json()) as { peer?: string; message?: string };
    return HttpResponse.json({
      ok: true,
      peerName: body.peer ?? 'foundry-research',
      responseText: `Mock peer reply to: ${body.message}`,
      traceId: '00-mocktrace-0000-01',
      cardUrl: 'https://foundry.example/agents/research/agentCard/v1.0',
    });
  }),
  http.post('*/agents/:name/responses', ({ params }) =>
    sseResponse([
      { type: 'response.output_text.delta', delta: `Mock response from ${String(params.name)}: ` },
      { type: 'response.output_text.delta', delta: 'hello from the agent.' },
      { type: 'response.completed', response: { id: `resp-${crypto.randomUUID()}`, status: 'completed' } },
    ]),
  ),
  http.post('*/models/v1/chat/completions', () =>
    sseResponse([
      { choices: [{ delta: { content: 'Mock model response: ' } }] },
      { choices: [{ delta: { content: 'hello from the model.' } }] },
      '[DONE]',
    ]),
  ),
  http.get('*/v1/agents/:name/spans', ({ params }) => {
    const agentName = String(params.name);
    return sseResponse([
      sampleSpan(agentName, 'invoke_agent', 'server', 850, {
        'a365.agent.id': agentName,
        'http.request.method': 'POST',
        'http.route': '/v1/responses',
      }, 0),
      sampleSpan(agentName, 'call_model', 'client', 720, {
        'gen_ai.request.model': 'qwen2.5-7b-instruct',
        'gen_ai.usage.input_tokens': 124,
        'gen_ai.usage.output_tokens': 88,
      }, 1),
      sampleSpan(agentName, 'execute_tool', 'internal', 12, {
        'tool.name': 'find_destinations',
      }, 2),
      sampleSpan(agentName, 'POST /v1/responses', 'server', 905, {
        'http.request.method': 'POST',
        'http.route': '/v1/responses',
      }, 3),
    ]);
  }),
];
