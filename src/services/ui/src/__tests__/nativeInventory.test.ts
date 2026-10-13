import { http, HttpResponse } from 'msw';
import { Agent, AgentVersion, getAgent, getEnvironment, listAgents, listAgentVersions } from '../api/client';
import { server } from '../mocks/server';

const agent: Agent = {
  name: 'writer', type: 'prompt', version: 'amber', phase: 'Ready',
  requestedActiveVersion: 'birch', activeVersion: 'amber',
  endpoint: '/agents/writer/versions/amber/responses',
  model: 'local-chat', instructions: 'Write clearly',
  description: 'Captured description', created: 1, updated: 2,
  identity: { entraClientId: 'entra', blueprintId: 'blueprint', keycloakClientId: 'local' },
  temperature: 0.5, topP: 0.9, tools: [],
  skills: [{ path: 'writing/SKILL.md', name: 'writing', description: 'Write well' }],
  image: null, port: null, definition: 'captured definition',
};

const retained: Agent = {
  ...agent, version: 'retained', model: 'retained-model',
  endpoint: '/agents/writer/versions/retained/responses',
};

const versions: AgentVersion[] = [
  { name: 'writer', version: 'retained', created_at: 0, status: 'Retired',
    endpoint: null, definitionDigest: 'sha256:retained', requestedActive: false, active: false },
  { name: 'writer', version: 'birch', created_at: 2, status: 'Available',
    endpoint: '/agents/writer/versions/birch/responses', definitionDigest: 'sha256:birch',
    requestedActive: true, active: false },
  { name: 'writer', version: 'amber', created_at: 1, status: 'Available',
    endpoint: agent.endpoint, definitionDigest: 'sha256:amber', requestedActive: false, active: true },
];

it('uses direct operational records and exact native URLs without environment lookup or pagination', async () => {
  const paths: string[] = [];
  let environmentCalls = 0;
  const record = (request: Request, body: Agent | { object: 'list'; data: Agent[] | AgentVersion[] }) => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    expect(url.search).toBe('');
    return HttpResponse.json(body);
  };
  server.use(
    http.get('*/v1/environment', () => {
      environmentCalls += 1;
      return new HttpResponse(null, { status: 503 });
    }),
    http.get('*/v1/agents', ({ request }) => record(request, { object: 'list', data: [agent] })),
    http.get('*/v1/agents/writer', ({ request }) => record(request, agent)),
    http.get('*/v1/agents/writer/versions/retained', ({ request }) => record(request, retained)),
    http.get('*/v1/agents/writer/versions', ({ request }) => record(request, { object: 'list', data: versions })),
  );
  expect(await listAgents()).toEqual([agent]);
  expect(await getAgent('writer')).toEqual(agent);
  expect(await getAgent('writer', 'retained')).toEqual(retained);
  expect(await listAgentVersions('writer')).toEqual(versions);
  expect(paths).toEqual([
    '/v1/agents', '/v1/agents/writer', '/v1/agents/writer/versions/retained', '/v1/agents/writer/versions',
  ]);
  expect(environmentCalls).toBe(0);
});

it('encodes names and opaque release IDs as path segments', async () => {
  const paths: string[] = [];
  server.use(http.get('*/v1/agents/:name/versions/:version', ({ request }) => {
    paths.push(new URL(request.url).pathname);
    return HttpResponse.json(retained);
  }));
  await getAgent('writer/name', 'retained?release');
  expect(paths).toEqual(['/v1/agents/writer%2Fname/versions/retained%3Frelease']);
});

const inventoryReads = [
  ['/v1/agents', listAgents, [{ object: 'list' }, { object: 'list', data: [{}] }]],
  ['/v1/agents/writer', () => getAgent('writer'), [{}, { ...agent, endpoint: 42 }, { adaptive: agent }]],
  ['/v1/agents/writer/versions/retained', () => getAgent('writer', 'retained'),
    [{}, { ...retained, phase: 'Unknown' }, { adaptive: retained }]],
  ['/v1/agents/writer/versions', () => listAgentVersions('writer'),
    [{ object: 'list' }, { object: 'list', data: [{ ...versions[0], status: 'Ready' }] }]],
] as const;

it.each(inventoryReads)('rejects missing and invalid data from %s explicitly', async (path, read, bodies) => {
  for (const body of bodies) {
    server.use(http.get(`*${path}`, () => HttpResponse.json(body)));
    await expect(read()).rejects.toThrow();
  }
});

it.each(inventoryReads)('surfaces unavailable inventory at %s without retries or release fallback', async (path, read) => {
  const calls: string[] = [];
  server.use(http.get(`*${path}`, ({ request }) => {
    calls.push(new URL(request.url).pathname);
    return HttpResponse.json({ code: 'not_found', message: 'Inventory unavailable' }, { status: 404 });
  }));
  await expect(read()).rejects.toThrow(`GET ${path} failed with 404: Inventory unavailable`);
  expect(calls).toEqual([path]);
});

it('reads environment without an emulated project identifier while retaining genuine cloud linkage', async () => {
  const environment = {
    name: 'local', description: 'Edge environment',
    cloud: {
      enabled: true,
      foundryProjectEndpoint: 'https://resource.services.ai.azure.com/api/projects/cloud-project',
      foundryProjectArmId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws/projects/cloud-project',
    },
  };
  server.use(http.get('*/v1/environment', () => HttpResponse.json(environment)));
  expect(await getEnvironment()).toEqual(environment);
});
