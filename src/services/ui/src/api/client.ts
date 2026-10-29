import { z } from 'zod';
import { authenticatedFetch } from '../auth/oidc';
import { readSseStream, SseMessage } from './sse';

export const ModelProviderSchema = z.string();

export const ModelSetMemberSchema = z.object({
  model: z.string(),
  priority: z.number().int(),
});

export const ModelSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number().int().nullish(),
  owned_by: z.string().nullish(),
  provider: ModelProviderSchema.nullish(),
  kind: z.enum(['single', 'set']).nullish(),
  status: z.enum(['Provisioning', 'Ready', 'Unknown']).nullish(),
  members: z.array(ModelSetMemberSchema).nullish(),
});

export const ModelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(ModelSchema),
});

export const EnvironmentCloudConfigSchema = z.object({
  enabled: z.boolean(),
  foundryProjectEndpoint: z.string().nullish(),
  foundryProjectArmId: z.string().nullish(),
});

export const EnvironmentSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  cloud: EnvironmentCloudConfigSchema,
});

export const AgentIdentitySchema = z.object({
  entraClientId: z.string().nullish(),
  blueprintId: z.string().nullish(),
  keycloakClientId: z.string().nullish(),
  entraTenantId: z.string().nullish(),
  oboClientId: z.string().nullish(),
  graphDelegation: z.boolean().optional(),
  agentUserId: z.string().nullish(),
});

export const ImpersonationModeSchema = z.enum(['app', 'endUserOBO', 'agentUser']);
export const ToolAuthTypeSchema = z.enum(['none', 'entra']);
export const ToolExecutionIdentitySchema = z.enum(['caller', 'server']);

export const ToolCatalogEntrySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  kind: z.enum(['mcp', 'builtin']),
  builtin: z.literal('graph-me').optional(),
  authType: ToolAuthTypeSchema,
  audience: z.string().optional(),
  identityModes: z.array(ImpersonationModeSchema),
  executionIdentity: ToolExecutionIdentitySchema,
}).or(z.object({
  name: z.literal('skills'),
  kind: z.literal('skills'),
  displayName: z.string(),
  description: z.string(),
}));

export const ToolCatalogListSchema = z.object({
  object: z.literal('list'),
  data: z.array(ToolCatalogEntrySchema),
});

const ToolIdentitySchema = z.object({
  authType: ToolAuthTypeSchema,
  audience: z.string().optional(),
  identityModes: z.array(ImpersonationModeSchema),
  executionIdentity: ToolExecutionIdentitySchema,
});

export const AgentToolRefSchema = z.discriminatedUnion('type', [ToolIdentitySchema.extend({
  type: z.literal('mcp'),
  connectionRef: z.string(),
  serverLabel: z.string(),
  serverUrl: z.string(),
  requireApproval: z.enum(['never', 'always']),
  allowedTools: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
}), ToolIdentitySchema.extend({
  type: z.literal('builtin'),
  name: z.literal('graph-me'),
  connectionRef: z.string(),
  serverLabel: z.string(),
  requireApproval: z.literal('never'),
})]);

export const AgentSchema = z.object({
  name: z.string(),
  type: z.enum(['prompt', 'hosted']),
  description: z.string().nullish(),
  endpoint: z.string().nullable(),
  created: z.number().int().nullish(),
  updated: z.number().int().nullish(),
  identity: AgentIdentitySchema.nullish(),
  phase: z.enum(['Pending', 'Ready', 'Failed']).nullish(),
  instructions: z.string().nullish(),
  model: z.string().nullish(),
  temperature: z.number().nullish(),
  topP: z.number().nullish(),
  tools: z.array(AgentToolRefSchema).nullish(),
  skills: z.array(z.object({
    path: z.string(),
    name: z.string(),
    description: z.string(),
  })).nullish(),
  image: z.string().nullish(),
  port: z.number().int().nullish(),
  definition: z.string().nullish(),
});

const PolicyRuleSchema = z.object({
  name: z.string(),
  stage: z.enum(['pre_input', 'pre_tool']),
  condition: z.string(),
  action: z.enum(['allow', 'deny', 'require_approval']),
  description: z.string(),
});
export const PolicyBundleSchema = z.object({
  policies: z.array(z.object({
    name: z.string(),
    apiVersion: z.literal('governance.toolkit/v1'),
    default_action: z.literal('deny'),
    mode: z.enum(['enforce', 'audit']).optional(),
    rules: z.array(PolicyRuleSchema),
  })),
});
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;
const PolicyResourceSchema = z.object({
  reference: z.string(),
  namespace: z.string(),
  targets: z.array(z.string()),
  bundle: PolicyBundleSchema,
});
export type PolicyResource = z.infer<typeof PolicyResourceSchema>;
const PlatformGuardrailsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['enforce', 'audit']).nullable(),
  policies: z.array(PolicyResourceSchema),
  enforcementVerified: z.boolean().optional(),
});
const AgentGuardrailsSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  mode: z.enum(['enforce', 'audit']).nullable(),
  inherited: z.array(PolicyResourceSchema),
  attached: PolicyResourceSchema.nullable(),
  policy_sha256: z.string().nullable(),
  deployment: z.string().nullable(),
  phase: z.string().nullable(),
  enforcementVerified: z.boolean().optional(),
});

export function getPlatformGuardrails(): Promise<z.infer<typeof PlatformGuardrailsSchema>> {
  return requestJson('/v1/guardrails', PlatformGuardrailsSchema);
}

export function getAgentGuardrails(name: string): Promise<z.infer<typeof AgentGuardrailsSchema>> {
  return requestJson(`/v1/agents/${encodeURIComponent(name)}/guardrails`, AgentGuardrailsSchema);
}

export const ConnectivityFaultStateSchema = z.object({
  enabled: z.boolean(),
  policyName: z.literal('demo-cloud-egress'),
  namespace: z.string(),
});

export const ConnectivityFaultUpdateSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const AgentCardCapabilitiesSchema = z.object({
  streaming: z.boolean().nullish(),
  pushNotifications: z.boolean().nullish(),
  extendedAgentCard: z.boolean().nullish(),
});

export const AgentCardSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  examples: z.array(z.string()).nullish(),
  inputModes: z.array(z.string()).nullish(),
  outputModes: z.array(z.string()).nullish(),
});

const AgentCardSchema = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  version: z.string().nullish(),
  capabilities: AgentCardCapabilitiesSchema.nullish(),
  defaultInputModes: z.array(z.string()).nullish(),
  defaultOutputModes: z.array(z.string()).nullish(),
  skills: z.array(AgentCardSkillSchema).nullish(),
});

export const AllowedCallerSchema = z.object({
  kind: z.enum(['foundryAgent', 'adaptiveAgent', 'anyAuthenticated']),
  oid: z.string().nullish(),
  agentId: z.string().nullish(),
  name: z.string().nullish(),
});

export const A2APeerSchema = z.object({
  name: z.string(),
  cardUrl: z.string().nullish(),
  a2aBaseUrl: z.string().nullish(),
  audience: z.string().nullish(),
  protocolVersion: z.string().nullish(),
  protocolBinding: z.enum(['JSONRPC', 'HTTP+JSON']).nullish(),
  auth: z.enum(['agentIdentity', 'keycloakClientCredentials', 'none']).nullish(),
  graphResourceAppId: z.string().nullish(),
  graphAppRoleId: z.string().nullish(),
  ready: z.boolean().nullish(),
  lastCardFetchedAt: z.string().nullish(),
});

export const AgentCardResponseSchema = z.object({
  enabled: z.boolean(),
  declared: AgentCardSchema,
  resolved: z.record(z.string(), z.any()),
  observedCardHash: z.string().nullish(),
  resolvedCardHash: z.string(),
  audience: z.string().nullish(),
  cardUrl: z.string().nullish(),
  a2aBaseUrl: z.string().nullish(),
  connectionString: z.string().nullish(),
  allowedCallers: z.array(AllowedCallerSchema),
  peers: z.array(A2APeerSchema),
  blueprintConsentPending: z.boolean().nullish(),
});

export const AgentCardDifferenceSchema = z.object({
  path: z.string(),
  declared: z.unknown().nullish(),
  live: z.unknown().nullish(),
});

export const AgentCardValidationSchema = z.object({
  valid: z.boolean(),
  live: z.enum(['fetched', 'unavailable']).nullish(),
  differences: z.array(AgentCardDifferenceSchema).nullish(),
  message: z.string().nullish(),
});

export const TestA2ACallSchema = z.object({
  peer: z.string(),
  message: z.string(),
});

export const TestA2ACallResultSchema = z.object({
  ok: z.boolean(),
  peerName: z.string(),
  responseText: z.string().nullish(),
  traceId: z.string().nullish(),
  cardUrl: z.string().nullish(),
  errorMessage: z.string().nullish(),
});

export type Model = z.infer<typeof ModelSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type ModelSetMember = z.infer<typeof ModelSetMemberSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export type ConnectivityFaultState = z.infer<typeof ConnectivityFaultStateSchema>;
export type AgentCardResponse = z.infer<typeof AgentCardResponseSchema>;
export type AgentCardValidation = z.infer<typeof AgentCardValidationSchema>;
export type AgentCardDifference = z.infer<typeof AgentCardDifferenceSchema>;
export type TestA2ACall = z.infer<typeof TestA2ACallSchema>;
export type TestA2ACallResult = z.infer<typeof TestA2ACallResultSchema>;
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;
export type AgentToolRef = z.infer<typeof AgentToolRefSchema>;

export type ImpersonationMode = z.infer<typeof ImpersonationModeSchema>;

export type InvokeAgentOptions = {
  signal?: AbortSignal;
  onEvent?: (message: SseMessage) => void;
  impersonation?: ImpersonationMode;
  entraUserToken?: string;
};

export function modelBaseUrl(): string {
  return (import.meta.env.VITE_GATEWAY_URL?.trim() || '/models/v1').replace(/\/+$/, '');
}

function impersonationHeaders(mode: ImpersonationMode | undefined, entraUserToken?: string): Record<string, string> {
  if (mode !== undefined) ImpersonationModeSchema.parse(mode);
  if (entraUserToken !== undefined && mode !== 'endUserOBO') {
    throw new Error('An Entra user assertion is forbidden outside OBO invocation.');
  }
  if (!mode) {
    return {};
  }
  if (mode === 'endUserOBO') {
    if (!entraUserToken?.trim()) throw new Error('OBO requires an Entra user assertion.');
    return { 'X-Impersonation-Mode': mode, 'X-Entra-User-Token': entraUserToken };
  }
  return { 'X-Impersonation-Mode': mode };
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  apiCode?: string;
  apiMessage?: string;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.code === 'string') this.apiCode = obj.code;
      if (typeof obj.message === 'string') this.apiMessage = obj.message;
    }
  }
}

async function parseErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

export async function responseError(response: Response, context: string): Promise<ApiError> {
  const body = await parseErrorBody(response);
  const details = body && typeof body === 'object' ? body as {
    message?: unknown; detail?: unknown; error?: { message?: unknown };
  } : undefined;
  const detail = details?.error?.message ?? details?.message ?? details?.detail ?? body;
  return new ApiError(response.status,
    `${context} failed with ${response.status}${typeof detail === 'string' ? `: ${detail.slice(0, 300)}` : ''}`, body);
}

async function requestJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const method = init?.method ?? 'GET';
    throw await responseError(response, `${method} ${path}`);
  }

  return schema.parse(await response.json());
}

async function sendJson<T>(
  path: string,
  method: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  return requestJson(path, schema, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listModels(): Promise<Model[]> {
  return (await requestJson(`${modelBaseUrl()}/models`, ModelListSchema)).data;
}

export async function getEnvironment(): Promise<Environment> {
  return requestJson('/v1/environment', EnvironmentSchema);
}

export async function getConnectivityFault(): Promise<ConnectivityFaultState> {
  return requestJson('/v1/connectivity-fault', ConnectivityFaultStateSchema);
}

export async function patchConnectivityFault(enabled: boolean): Promise<ConnectivityFaultState> {
  return sendJson(
    '/v1/connectivity-fault',
    'PATCH',
    ConnectivityFaultUpdateSchema.parse({ enabled }),
    ConnectivityFaultStateSchema,
  );
}

export async function listAgents(): Promise<Agent[]> {
  return (await requestJson('/v1/agents', z.object({
    object: z.literal('list'),
    data: z.array(AgentSchema),
  }))).data;
}

export async function getAgent(name: string): Promise<Agent> {
  return requestJson(`/v1/agents/${encodeURIComponent(name)}`, AgentSchema);
}

export async function listTools(): Promise<ToolCatalogEntry[]> {
  return (await requestJson('/v1/tools', ToolCatalogListSchema)).data;
}

export async function streamAgentSpans(
  name: string,
  { signal, onOpen, onEvent }: {
    signal: AbortSignal;
    onOpen: () => void;
    onEvent: (message: SseMessage) => void;
  },
): Promise<void> {
  const response = await authenticatedFetch(`/v1/agents/${encodeURIComponent(name)}/spans`, {
    signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!response.ok) {
    throw new ApiError(response.status, `Monitor stream failed with ${response.status}`, await parseErrorBody(response));
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Expected a Monitor event stream.');
  }
  onOpen();
  await readSseStream(response, onEvent);
}

export async function invokeAgent(
  endpoint: string,
  body: Record<string, unknown>,
  { signal, onEvent, impersonation, entraUserToken }: InvokeAgentOptions = {},
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...impersonationHeaders(impersonation, entraUserToken),
  };
  const response = await authenticatedFetch(endpoint, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await responseError(response, 'Agent invocation');
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Expected a native Responses event stream.');
  }

  await readSseStream(response, (message) => onEvent?.(message));
}

export async function getAgentCard(name: string): Promise<AgentCardResponse> {
  return requestJson(`/v1/agents/${encodeURIComponent(name)}/agent-card`, AgentCardResponseSchema);
}

export async function validateAgentCard(name: string): Promise<AgentCardValidation> {
  return sendJson(
    `/v1/agents/${encodeURIComponent(name)}/agent-card/validate`,
    'POST',
    {},
    AgentCardValidationSchema,
  );
}

export async function testA2ACall(name: string, body: TestA2ACall): Promise<TestA2ACallResult> {
  return sendJson(
    `/v1/agents/${encodeURIComponent(name)}/a2a/test-call`,
    'POST',
    TestA2ACallSchema.parse(body),
    TestA2ACallResultSchema,
  );
}
