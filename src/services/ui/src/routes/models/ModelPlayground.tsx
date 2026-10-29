import { Button, Dropdown, Field, Option, Spinner, Text, Textarea } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { streamChatCompletion, generateImage } from '../../api/chat';
import { listModels } from '../../api/client';
import { ChatPanel, SendChatArgs } from '../../components/ChatPanel';
import { useConnectivityFaultStore } from '../../state/connectivityFault';

type GenMode = 'chat' | 'image';

// ponytail: fixed list — OpenAI/gpt-image sizes. Model-agnostic; if the picked
// model rejects a size the gateway error surfaces in the chat panel.
const IMAGE_SIZES: { value: string; label: string }[] = [
  { value: '1024x1024', label: 'Square · 1024×1024' },
  { value: '1536x1024', label: 'Landscape · 1536×1024' },
  { value: '1024x1536', label: 'Portrait · 1024×1536' },
  { value: 'auto', label: 'Auto' },
];

export function ModelPlayground(): JSX.Element {
  const navigate = useNavigate();
  const { modelId } = useParams();
  const mode = useConnectivityFaultStore((state) => state.enabled);
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: listModels,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((m) => m.status === 'Provisioning') ? 5000 : false,
  });
  const models = useMemo(
    () =>
      (modelsQuery.data ?? []).filter(
        (model) => !mode || model.provider !== 'foundry',
      ),
    [modelsQuery.data, mode],
  );
  const [selectedModel, setSelectedModel] = useState(modelId ?? '');
  const [genMode, setGenMode] = useState<GenMode>('chat');
  const [imageSize, setImageSize] = useState('1024x1024');
  const [instructions, setInstructions] = useState('You are an AI assistant that helps people find information.');
  const isProvisioning = useMemo(
    () => models.find((m) => m.id === selectedModel)?.status === 'Provisioning',
    [models, selectedModel],
  );
  const selected = models.find((model) => model.id === selectedModel);
  const unavailable = modelsQuery.isLoading || Boolean(modelsQuery.error) || !selected || isProvisioning;

  useEffect(() => {
    if (!selectedModel && models[0]) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);
  useEffect(() => setSelectedModel(modelId ?? ''), [modelId]);

  const send = ({ messages, prompt, signal, onDelta, onModel }: SendChatArgs): Promise<void> => {
    if (modelsQuery.error || !selected) {
      return Promise.reject(new Error('Selected model is unavailable in the gateway catalogue. No fallback model will be used.'));
    }
    if (isProvisioning) {
      return Promise.reject(
        new Error('This model is still provisioning. Wait until it is Ready.'),
      );
    }
    if (genMode === 'image') {
      return generateImage({ model: selectedModel, prompt, size: imageSize, signal }).then(
        (src) => {
          onModel(selectedModel);
          const alt = prompt.replace(/[\]\r\n]+/g, ' ').trim();
          onDelta(`![${alt}](${src})`);
        },
      );
    }
    return streamChatCompletion({
      model: selectedModel,
      signal,
      messages: [
        ...(instructions.trim() ? [{ role: 'system' as const, content: instructions.trim() }] : []),
        ...messages,
      ],
      onDelta,
      onModel,
    });
  };

  return (
    <section className="page playground-page">
      <div className="playground-titlebar">
        <Button appearance="transparent" onClick={() => navigate('/models')}>
          ← Models
        </Button>
        <Text as="h1" size={500} weight="semibold">
          {selectedModel || modelId || 'Model playground'}
        </Text>
        {isProvisioning ? (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="The gateway reports provisioning; the model is not ready for invocation."
          >
            <Spinner size="tiny" />
            <Text size={200} className="muted-text">
              Provisioning…
            </Text>
          </span>
        ) : null}
      </div>
      <div className="playground-shell">
        <aside className="playground-left">
          <Field label="Model">
            <Dropdown
              value={selectedModel}
              selectedOptions={selectedModel ? [selectedModel] : []}
              onOptionSelect={(_, data) => setSelectedModel(data.optionValue ?? '')}
            >
              {models.map((model) => (
                <Option key={model.id} value={model.id} text={model.id}>
                  {model.id}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Mode">
            <Dropdown
              value={genMode === 'image' ? 'Image generation' : 'Text chat'}
              selectedOptions={[genMode]}
              onOptionSelect={(_, data) => setGenMode((data.optionValue as GenMode) ?? 'chat')}
            >
              <Option value="chat" text="Text chat">
                Text chat
              </Option>
              <Option value="image" text="Image generation">
                Image generation
              </Option>
            </Dropdown>
          </Field>
          {genMode === 'image' ? (
            <Field label="Image size">
              <Dropdown
                value={IMAGE_SIZES.find((s) => s.value === imageSize)?.label ?? imageSize}
                selectedOptions={[imageSize]}
                onOptionSelect={(_, data) => setImageSize(data.optionValue ?? '1024x1024')}
              >
                {IMAGE_SIZES.map((s) => (
                  <Option key={s.value} value={s.value} text={s.label}>
                    {s.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          ) : (
            <Field label="System instructions">
              <Textarea
                value={instructions}
                resize="vertical"
                onChange={(_, data) => setInstructions(data.value)}
              />
            </Field>
          )}
          {modelsQuery.isLoading ? <Spinner label="Loading models" /> : null}
          {modelsQuery.error ? <Text role="alert">Failed to load models: {modelsQuery.error.message}</Text> : null}
          {!modelsQuery.isLoading && !modelsQuery.error && !selected
            ? <Text role="alert">Selected model is unavailable in the gateway catalogue for this mode. Select a model explicitly.</Text> : null}
        </aside>
        <main className="playground-main">
          <ChatPanel
            key={`${selectedModel}:${genMode}`}
            emptyTitle={
              genMode === 'image'
                ? 'Describe an image to generate'
                : 'What do you want to chat about?'
            }
            placeholder={genMode === 'image' ? 'Describe an image…' : 'Chat with the model...'}
            onSend={send}
            disabled={unavailable}
          />
        </main>
      </div>
    </section>
  );
}
