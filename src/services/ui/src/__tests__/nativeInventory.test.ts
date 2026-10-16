import { http, HttpResponse } from 'msw';
import { Agent, getAgent, getEnvironment, listAgents } from '../api/client';
import { server } from '../mocks/server';

const agent: Agent = {
  name: 'writer', type: 'prompt', phase: 'Ready',
  endpoint: '/agents/writer/responses',
  model: 'local-chat', instructions: 'Write clearly',
  description: 'Current description', created: 1, updated: 2,
  identity: { entraClientId: 'entra', blueprintId: 'blueprint', keycloakClientId: 'local' },
  temperature: 0.5, topP: 0.9, tools: [],
  skills: [{ path: 'writing/SKILL.md', name: 'writing', description: 'Write well' }],
  image: null, port: null, definition: 'current definition',
};

it('uses direct operational records and stable native URLs without environment lookup or pagination', async () => {
  const paths: string[] = [];
  let environmentCalls = 0;
  const record = (request: Request, body: Agent | { object: 'list'; data: Agent[] }) => {
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
  );
  expect(await listAgents()).toEqual([agent]);
  expect(await getAgent('writer')).toEqual(agent);
  expect(paths).toEqual(['/v1/agents', '/v1/agents/writer']);
  expect(environmentCalls).toBe(0);
});

it('encodes agent names as path segments', async () => {
  const paths: string[] = [];
  server.use(http.get('*/v1/agents/:name', ({ request }) => {
    paths.push(new URL(request.url).pathname);
    return HttpResponse.json(agent);
  }));
  await getAgent('writer/name');
  expect(paths).toEqual(['/v1/agents/writer%2Fname']);
});

const inventoryReads = [
  ['/v1/agents', listAgents, [{ object: 'list' }, { object: 'list', data: [{}] }]],
  ['/v1/agents/writer', () => getAgent('writer'), [{}, { ...agent, endpoint: 42 }, { adaptive: agent }]],
] as const;

it.each(inventoryReads)('rejects missing and invalid data from %s explicitly', async (path, read, bodies) => {
  for (const body of bodies) {
    server.use(http.get(`*${path}`, () => HttpResponse.json(body)));
    await expect(read()).rejects.toThrow();
  }
});

it.each(inventoryReads)('surfaces unavailable inventory at %s without retries', async (path, read) => {
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
    cloud: { enabled: false, foundryProjectEndpoint: null, foundryProjectArmId: null },
  };
  server.use(http.get('*/v1/environment', () => HttpResponse.json(environment)));
  expect(await getEnvironment()).toEqual(environment);
});
