import { z } from 'zod';
import { authenticatedFetch } from '../auth/oidc';
import { modelBaseUrl, responseError } from './client';
import { readSseStream } from './sse';

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatCompletionMessage = {
  role: ChatRole;
  content: string;
};

export type StreamChatCompletionArgs = {
  model: string;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onModel?: (model: string) => void;
};

export type GenerateImageArgs = {
  model: string;
  prompt: string;
  size?: string;
  signal?: AbortSignal;
};

const ImageResponseSchema = z.object({
  data: z
    .array(z.object({ url: z.string().optional(), b64_json: z.string().optional() }))
    .min(1),
});

// ponytail: model-agnostic — sends whatever model/size the user picked to the
// gateway's OpenAI-compatible /v1/images/generations. If the selected model
// can't do images the gateway errors and we surface it; no per-model allow-list.
export async function generateImage({
  model,
  prompt,
  size,
  signal,
}: GenerateImageArgs): Promise<string> {
  const response = await authenticatedFetch(`${modelBaseUrl()}/images/generations`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, ...(size ? { size } : {}) }),
  });

  if (!response.ok) {
    throw await responseError(response, 'Image generation');
  }

  const image = ImageResponseSchema.parse(await response.json()).data[0];
  if (image.url) {
    return image.url;
  }
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }
  throw new Error('Image response contained no image data');
}

const ChatDeltaSchema = z.object({
  model: z.string().optional(),
  choices: z.array(
    z.object({
      delta: z
        .object({
          content: z.string().nullish(),
        })
        .optional(),
      finish_reason: z.string().nullish(),
    }),
  ),
});

export async function streamChatCompletion({
  model,
  messages,
  signal,
  onDelta,
  onModel,
}: StreamChatCompletionArgs): Promise<void> {
  const response = await authenticatedFetch(`${modelBaseUrl()}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) {
    throw await responseError(response, 'Chat completion');
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Expected a native chat completion event stream.');
  }

  let reportedModel: string | undefined;
  let completed = false;

  await readSseStream(response, ({ data }) => {
    if (data === '[DONE]') {
      completed = true;
      return;
    }

    const value = JSON.parse(data);
    if (value.error) throw new Error(value.error.message ?? 'Native chat completion failed.');
    const parsed = ChatDeltaSchema.parse(value);
    if (onModel && parsed.model && parsed.model !== reportedModel) {
      reportedModel = parsed.model;
      onModel(parsed.model);
    }
    const delta = parsed.choices[0]?.delta?.content;
    if (delta) {
      onDelta(delta);
    }
  });
  signal?.throwIfAborted();
  if (!completed) throw new Error('Native chat stream ended without [DONE]; the turn outcome is uncertain.');
}
