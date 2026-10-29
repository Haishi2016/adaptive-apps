import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ChatPanel, SendChatArgs } from '../components/ChatPanel';
import { renderWithProviders } from './testUtils';

describe('ChatPanel', () => {
  it('prevents form submission when invocation is disabled', () => {
    let calls = 0;
    renderWithProviders(
      <ChatPanel emptyTitle="empty" placeholder="msg" disabled onSend={async () => { calls += 1; }} />,
    );
    fireEvent.change(screen.getByLabelText('msg'), { target: { value: 'hi' } });
    expect(screen.getByLabelText('Send')).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Send').closest('form')!);
    expect(calls).toBe(0);
  });

  it('renders the assistant model name beside the role label', async () => {
    const onSend = async ({ onDelta, onModel }: SendChatArgs): Promise<void> => {
      onModel('gpt-5.4-mini-2026-03-17');
      onDelta('Hello!');
    };

    renderWithProviders(
      <ChatPanel emptyTitle="empty" placeholder="msg" onSend={onSend} />,
    );

    const textarea = screen.getByLabelText('msg');
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(screen.getByText('gpt-5.4-mini-2026-03-17')).toBeInTheDocument());
    expect(screen.getByText('Assistant')).toBeInTheDocument();
  });

  it('does not render a model badge when no model is reported', async () => {
    const onSend = async ({ onDelta }: SendChatArgs): Promise<void> => {
      onDelta('plain answer');
    };

    renderWithProviders(
      <ChatPanel emptyTitle="empty" placeholder="msg" onSend={onSend} />,
    );

    const textarea = screen.getByLabelText('msg');
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(screen.getByText('plain answer')).toBeInTheDocument());
    expect(screen.queryByText(/gpt-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/qwen/)).not.toBeInTheDocument();
  });

  it('still works when crypto.randomUUID is not available (insecure context)', async () => {
    const originalRandomUUID = (crypto as Crypto & { randomUUID?: () => string }).randomUUID;
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });

    try {
      const onSend = async ({ onDelta }: SendChatArgs): Promise<void> => {
        onDelta('insecure-context reply');
      };

      renderWithProviders(
        <ChatPanel emptyTitle="empty" placeholder="msg" onSend={onSend} />,
      );

      const textarea = screen.getByLabelText('msg');
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() =>
        expect(screen.getByText('insecure-context reply')).toBeInTheDocument(),
      );
    } finally {
      Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });
});
