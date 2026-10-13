import { Button, Text, Textarea } from '@fluentui/react-components';
import { DismissRegular, SendRegular } from '@fluentui/react-icons';
import { FormEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { ChatCompletionMessage, ChatRole } from '../api/chat';

export type ChatMessage = ChatCompletionMessage & {
  id: string;
  model?: string;
  tools?: string[];
};

export type SendChatArgs = {
  messages: ChatCompletionMessage[];
  prompt: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onModel: (model: string) => void;
  onToolEvent?: (tool: string) => void;
};

export type ChatPanelProps = {
  title?: string;
  emptyTitle: string;
  emptySubtitle?: string | null;
  placeholder: string;
  onSend: (args: SendChatArgs) => Promise<void>;
  disabled?: boolean;
  onReset?: () => void;
};

function toCompletionMessage(message: ChatMessage): ChatCompletionMessage {
  return { role: message.role, content: message.content };
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // crypto.randomUUID is only available in secure contexts (https / localhost).
  // When the UI is opened over plain http on a remote IP (e.g. WSL2 host
  // address) the call throws, breaking the chat input. Fall back to a
  // collision-resistant RFC-4122-shaped id from Math.random.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nextMessage(role: ChatRole, content: string): ChatMessage {
  return { id: `${role}-${makeId()}`, role, content };
}

export function ChatPanel({
  title = 'Chat',
  emptyTitle,
  emptySubtitle,
  placeholder,
  onSend,
  disabled = false,
  onReset,
}: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController>();
  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || isStreaming || disabled) {
      return;
    }

    const userMessage = nextMessage('user', prompt);
    const assistantMessage = nextMessage('assistant', '');
    const outgoing = [...messages, userMessage];
    setMessages([...outgoing, assistantMessage]);
    setDraft('');
    setError(undefined);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await onSend({
        messages: outgoing.map(toCompletionMessage),
        prompt,
        signal: controller.signal,
        onDelta: (delta) => {
          if (!delta) {
            return;
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, content: `${message.content}${delta}` }
                : message,
            ),
          );
        },
        onModel: (model) => {
          if (!model) {
            return;
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id ? { ...message, model } : message,
            ),
          );
        },
        onToolEvent: (tool) => setMessages((current) => current.map((message) =>
          message.id === assistantMessage.id ? { ...message, tools: [...(message.tools ?? []), tool] } : message)),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Message failed');
    } finally {
      setIsStreaming(false);
      abortRef.current = undefined;
    }
  };

  return (
    <section className="chat-panel" aria-label={title}>
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-mark">✦</div>
            <Text as="h2" size={500} weight="semibold">
              {emptyTitle}
            </Text>
            {emptySubtitle ? <Text>{emptySubtitle}</Text> : null}
          </div>
        ) : (
          messages.map((message, index) => (
            <article key={message.id} className={`chat-message ${message.role}`}>
              <div className="chat-message-header">
                <Text weight="semibold">{message.role === 'user' ? 'You' : 'Assistant'}</Text>
                {message.role === 'assistant' && message.model ? (
                  <Text className="chat-message-model" size={200} title={message.model}>
                    {message.model}
                  </Text>
                ) : null}
              </div>
              {message.tools?.map((tool, toolIndex) => <Text key={toolIndex} size={200}>Tool call: {tool}</Text>)}
              <ReactMarkdown
                urlTransform={(url) =>
                  /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url)
                    ? url
                    : defaultUrlTransform(url)
                }
              >
                {message.content || ' '}
              </ReactMarkdown>
              {isStreaming && index === messages.length - 1 && message.role === 'assistant' ? (
                <span className="streaming-cursor">▌</span>
              ) : null}
            </article>
          ))
        )}
      </div>
      {error ? <div className="chat-error" role="alert">{error}</div> : null}
      <form className="chat-composer" onSubmit={(event) => void submit(event)}>
        <Textarea
          aria-label={placeholder}
          appearance="filled-darker"
          placeholder={placeholder}
          value={draft}
          resize="vertical"
          onChange={(_, data) => setDraft(data.value)}
        />
        <div className="composer-actions">
          {onReset ? <Button disabled={isStreaming} onClick={() => {
            onReset();
            setMessages([]);
            setDraft('');
            setError(undefined);
          }}>New conversation</Button> : null}
          {isStreaming ? (
            <Button
              aria-label="Cancel"
              icon={<DismissRegular />}
              onClick={() => abortRef.current?.abort()}
            />
          ) : null}
          <Button
            aria-label="Send"
            appearance="primary"
            icon={<SendRegular />}
            type="submit"
            disabled={!draft.trim() || isStreaming || disabled}
          >
            Send
          </Button>
        </div>
      </form>
    </section>
  );
}
