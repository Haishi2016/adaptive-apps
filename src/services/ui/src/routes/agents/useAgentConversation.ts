import { useCallback, useEffect, useRef, useState } from 'react';
import { Agent, getAgent, ImpersonationMode, invokeAgent } from '../../api/client';
import { useAuthStore } from '../../auth/store';
import { acquireEntraUserToken } from '../../auth/entra';
import { authSessionVersion } from '../../auth/oidc';
import { SendChatArgs } from '../../components/ChatPanel';
import { useConnectivityFaultStore } from '../../state/connectivityFault';
import { allowedIdentityModes } from './identityModes';

type Conversation = {
  agent: Agent;
  impersonation: ImpersonationMode;
  user: string | undefined;
  session: number;
  failed?: boolean;
};

export function useAgentConversation(name: string, impersonation: ImpersonationMode, faultEnabled: boolean) {
  const conversation = useRef<Conversation>();
  const [pinned, setPinned] = useState<Agent>();
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);

  const reset = useCallback(() => {
    conversation.current = undefined;
    setPinned(undefined);
    setFailed(false);
    setStarted(false);
  }, []);
  useEffect(reset, [name, reset]);

  const send = async ({ prompt, signal, onDelta, onModel, onToolEvent }: SendChatArgs): Promise<void> => {
    try {
      setStarted(true);
      const principal = useAuthStore.getState().user;
      const userKey = () => {
        const current = useAuthStore.getState().user;
        return current ? JSON.stringify([current.iss, current.sub, current.entra_tid, current.entra_oid]) : undefined;
      };
      const user = userKey();
      const session = authSessionVersion();
      const assertCaller = () => {
        if (session !== authSessionVersion() || user !== userKey()) {
          throw new Error('Platform session changed. No invocation was sent.');
        }
        if (impersonation !== 'app' && useConnectivityFaultStore.getState().enabled) {
          throw new Error('Cloud fault configuration changed. Selected cloud identity is unavailable.');
        }
      };
      if (!conversation.current) {
        const agent = await getAgent(name);
        signal.throwIfAborted();
        assertCaller();
        if (agent.phase !== 'Ready' || !agent.endpoint) {
          throw new Error('Agent runtime is unavailable.');
        }
        if (!allowedIdentityModes(agent, faultEnabled, principal).includes(impersonation)) {
          throw new Error('Selected identity is unsupported by the captured tools.');
        }
        conversation.current = { agent, impersonation, user, session };
        setPinned(agent);
      }
      const current = conversation.current;
      if (current.failed || current.agent.name !== name || current.user !== user
          || current.session !== session || current.impersonation !== impersonation) {
        throw new Error('Conversation identity changed or an earlier turn failed. Start a new conversation.');
      }
      if (!allowedIdentityModes(current.agent, faultEnabled, principal).includes(current.impersonation)) {
        throw new Error('Selected identity is no longer available.');
      }
      const entraUserToken = current.impersonation === 'endUserOBO'
        ? await acquireEntraUserToken(current.agent, principal!) : undefined;
      signal.throwIfAborted();
      assertCaller();
      let completedId: string | undefined;
      await invokeAgent(current.agent.endpoint!, {
        input: prompt,
        store: false,
        stream: true,
      }, {
        signal,
        impersonation: current.impersonation,
        entraUserToken,
        onEvent: ({ event, data }) => {
          if (data === '[DONE]') return;
          const value = JSON.parse(data) as {
            type?: string;
            delta?: string;
            message?: string;
            error?: { message?: string };
            item?: { type?: string; name?: string };
            response?: {
              id?: string;
              status?: string;
              model?: string;
              error?: { message?: string };
              incomplete_details?: { reason?: string };
            };
          };
          const type = value.type ?? event;
          if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
            throw new Error(value.response?.error?.message ?? value.error?.message ?? value.message
              ?? value.response?.incomplete_details?.reason ?? `Native response failed: ${type}`);
          }
          if (completedId) throw new Error('Unexpected event after native completion.');
          if (type === 'response.output_text.delta' && typeof value.delta === 'string') onDelta(value.delta);
          if (value.response?.model) onModel(value.response.model);
          if (type === 'response.output_item.added' && value.item?.type?.includes('call')) {
            onToolEvent?.(value.item.name ?? value.item.type);
          }
          if (type === 'response.completed') {
            if (value.response?.status !== 'completed' || !value.response.id) {
              throw new Error('Invalid native response completion.');
            }
            completedId = value.response.id;
          }
        },
      });
      signal.throwIfAborted();
      if (!completedId) throw new Error('Native stream ended without response.completed; the turn outcome is uncertain.');
    } catch (error) {
      if (conversation.current) conversation.current.failed = true;
      setFailed(true);
      const reason = signal.aborted ? 'Turn cancelled; tool effects may already have occurred.'
        : error instanceof Error ? error.message : 'Native response failed.';
      throw new Error(`${reason} Start a new conversation; this turn will not be replayed.`);
    }
  };

  return { pinned, failed, started, send, reset };
}
