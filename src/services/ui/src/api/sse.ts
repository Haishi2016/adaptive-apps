export type SseMessage = {
  event?: string;
  data: string;
};

const lineBreak = /\r?\n/;

export function parseSseBlock(block: string): SseMessage | undefined {
  const data: string[] = [];
  let event: string | undefined;

  for (const line of block.split(lineBreak)) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') {
      event = value;
    }

    if (field === 'data') {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return { event, data: data.join('\n') };
}

function drainBuffer(buffer: string): { messages: SseMessage[]; remainder: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const blocks = normalised.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const messages = blocks
    .map(parseSseBlock)
    .filter((message): message is SseMessage => message !== undefined);

  return { messages, remainder };
}

export async function readSseStream(
  response: Response,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error('Expected a streaming response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    let reading = true;
    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      const drained = drainBuffer(buffer);
      buffer = drained.remainder;
      drained.messages.forEach(onMessage);
    }
    buffer += decoder.decode();
    if (parseSseBlock(buffer)) throw new Error('Truncated event stream.');
  } finally {
    // Cancellation can wait for another tee consumer; do not delay a native error.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
