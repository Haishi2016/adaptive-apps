import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { server } from '../mocks/server';
import { ModelPlayground } from '../routes/models/ModelPlayground';
import { renderWithProviders } from './testUtils';

function renderModel(model = 'qwen2.5-7b-instruct') {
  return renderWithProviders(
    <Routes><Route path="/models/:modelId/playground" element={<ModelPlayground />} /></Routes>,
    { route: `/models/${model}/playground` },
  );
}

it('sends to the authenticated model gateway and renders native streamed output', async () => {
  let body: unknown;
  server.use(http.post('*/models/v1/chat/completions', async ({ request }) => {
    body = await request.json();
    return new HttpResponse('data: {"choices":[{"delta":{"content":"Gateway reply"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }));
  renderModel();
  fireEvent.change(screen.getByLabelText('Chat with the model...'), { target: { value: 'Hello' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Gateway reply')).toBeInTheDocument();
  expect(body).toMatchObject({ model: 'qwen2.5-7b-instruct', stream: true });
});

it.each(['failed', 'empty', 'missing'] as const)('disables send for %s discovery without selecting another model', async (kind) => {
  const invoke = vi.fn();
  server.use(
    http.get('*/models/v1/models', () => kind === 'failed'
      ? HttpResponse.json({ error: { message: 'Catalogue denied' } }, { status: 403 })
      : HttpResponse.json({ object: 'list', data: kind === 'empty' ? [] : [{ id: 'other', object: 'model' }] })),
    http.post('*/models/v1/chat/completions', invoke),
  );
  renderModel('pinned');
  fireEvent.change(screen.getByLabelText('Chat with the model...'), { target: { value: 'Hello' } });
  expect(await screen.findByRole('alert')).toHaveTextContent(kind === 'failed' ? 'Catalogue denied' : 'unavailable');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('heading', { name: 'pinned' })).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});
