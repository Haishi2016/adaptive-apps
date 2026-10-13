import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { ApiError, streamAgentSpans } from '../api/client';
import { server } from '../mocks/server';

afterEach(() => {
  localStorage.removeItem('adaptive.authToken');
});

it('streams Monitor records using the broker bearer, never a token query parameter', async () => {
  localStorage.setItem('adaptive.authToken', 'test-broker-bearer');
  const requests: Request[] = [];
  server.use(http.get('*/v1/agents/trip-scout/spans', ({ request }) => {
    requests.push(request);
    return new HttpResponse('data: {"span_id":"one"}\n\ndata: {"span_id":"two"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }));
  const onEvent = vi.fn();
  const onOpen = vi.fn();
  await streamAgentSpans('trip-scout', {
    signal: new AbortController().signal, onOpen, onEvent,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].headers.get('Authorization')).toBe('Bearer test-broker-bearer');
  expect(new URL(requests[0].url).search).toBe('');
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onEvent.mock.calls.map(([event]) => event.data)).toEqual([
    '{"span_id":"one"}', '{"span_id":"two"}',
  ]);
});

it('signals expired authentication without consuming a rejected stream', async () => {
  server.use(http.get('*/v1/agents/trip-scout/spans', () =>
    HttpResponse.json({ message: 'Expired' }, { status: 401 }),
  ));
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const onOpen = vi.fn();
  const onEvent = vi.fn();
  await expect(streamAgentSpans('trip-scout', {
    signal: new AbortController().signal, onOpen, onEvent,
  })).rejects.toMatchObject({ status: 401, name: ApiError.name });
  expect(dispatch.mock.calls.some(([event]) => event.type === 'adaptive:unauthorized')).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalled();
  dispatch.mockRestore();
});

it('rejects HTML or JSON in place of a Monitor stream', async () => {
  server.use(http.get('*/v1/agents/trip-scout/spans', () => HttpResponse.json({})));
  const onOpen = vi.fn();
  await expect(streamAgentSpans('trip-scout', {
    signal: new AbortController().signal, onOpen, onEvent: vi.fn(),
  })).rejects.toThrow('Expected a Monitor event stream.');
  expect(onOpen).not.toHaveBeenCalled();
});
