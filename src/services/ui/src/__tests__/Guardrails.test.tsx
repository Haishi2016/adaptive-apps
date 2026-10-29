import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { AgentGuardrails, PlatformGuardrails } from '../routes/guardrails/Guardrails';
import { renderWithProviders } from './testUtils';
import { App } from '../App';

const bundle = {
  policies: [{
    apiVersion: 'governance.toolkit/v1', name: 'baseline', default_action: 'deny',
    rules: [{
      name: 'responses-only', stage: 'pre_input', condition: "action == 'responses'",
      action: 'allow', description: '',
    }],
  }],
};
const platform = { reference: 'platform-ref', namespace: 'adaptive-guardrails-platform', targets: ['adaptive/*'], bundle };
const attached = { reference: 'application-ref', namespace: 'adaptive-guardrails-apps', targets: [], bundle: { policies: [{ ...bundle.policies[0], name: 'extra' }] } };

describe('Guardrails', () => {
  it('is reachable from the primary navigation', async () => {
    renderWithProviders(<App />, { route: '/guardrails' });
    expect(screen.getByRole('link', { name: 'Guardrails' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText(/No global policy resources configured/)).toBeInTheDocument();
  });
  it('shows platform policies without edit controls', async () => {
    server.use(http.get('*/v1/guardrails', () => HttpResponse.json({
      enabled: true, mode: 'enforce', policies: [
        { ...platform, bundle: { policies: [
          ...bundle.policies,
          ...['pii', 'prompt_injection'].map((check) => ({
            ...bundle.policies[0], name: `block-${check}`,
            rules: [{ ...bundle.policies[0].rules[0], condition: `${check} == 'clear'` }],
          })),
        ] } },
        attached,
      ],
    })));
    renderWithProviders(<PlatformGuardrails />);
    expect(await screen.findByText('application-ref')).toBeInTheDocument();
    expect(screen.queryByText(/Configured mode:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Automatic targets: adaptive\/\*/)).toBeInTheDocument();
    const rules = screen.getByRole('table', { name: 'Platform-owned policy rules' });
    expect(within(rules).getAllByRole('row')).toHaveLength(4);
    expect(within(rules).getByRole('rowheader', { name: /^baseline/ })).toBeInTheDocument();
    expect(screen.getAllByText('Declared mode: workload default (runtime unverified)')).not.toHaveLength(0);
    expect(screen.getByText("pii == 'clear'")).toBeInTheDocument();
    expect(screen.getByText("prompt_injection == 'clear'")).toBeInTheDocument();
    expect(screen.getByText(/do not redact/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows inactive state', async () => {
    renderWithProviders(<PlatformGuardrails />);
    expect(await screen.findByText(/No global policy resources configured/)).toBeInTheDocument();
  });

  it.each([null, 'audit', 'enforce'])('shows configured global policies independently of runtime mode %s', async (mode) => {
    server.use(http.get('*/v1/guardrails', () => HttpResponse.json({
      enabled: true, mode, policies: [platform],
    })));
    renderWithProviders(<App />, { route: '/guardrails' });
    expect(await within(screen.getByRole('banner')).findByText('Global policies: configured')).toBeInTheDocument();
    expect(screen.getByText(/Runtime enforcement: unverified/)).toBeInTheDocument();
    expect(screen.queryByText(/Configured mode:/)).not.toBeInTheDocument();
  });

  it('shows only absent global policies, not absent release governance', async () => {
    renderWithProviders(<App />);
    expect(await within(screen.getByRole('banner')).findByText('Global policies: none')).toBeInTheDocument();
    expect(screen.queryByText('Governance: not configured')).not.toBeInTheDocument();
  });

  it('shows unavailable governance rather than an inactive state when the API fails', async () => {
    server.use(http.get('*/v1/guardrails', () => HttpResponse.json({ detail: 'Unavailable' }, { status: 503 })));
    renderWithProviders(<App />);
    expect(await within(screen.getByRole('banner')).findByText('Global policies: unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Governance: not configured')).not.toBeInTheDocument();
  });

  it('shows pinned agent attachment separately from baseline', async () => {
    server.use(http.get('*/v1/agents/demo/guardrails', () => HttpResponse.json({
      name: 'demo', enabled: true, mode: 'audit',
      inherited: [platform], attached, policy_sha256: 'digest',
      deployment: 'demo-v1', phase: 'Available',
    })));
    renderWithProviders(<AgentGuardrails name="demo" visible />);
    expect(await screen.findByText('application-ref')).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText(/matching platform policies AND attached bundle/)).toBeInTheDocument();
    expect(screen.getByText(/does not verify enforcement/)).toBeInTheDocument();
  });

  it('shows configured release attachment with unknown runtime mode and no inherited policy', async () => {
    server.use(http.get('*/v1/agents/demo/guardrails', () => HttpResponse.json({
      name: 'demo', enabled: true, mode: null, enforcementVerified: false,
      inherited: [], attached, policy_sha256: null, deployment: 'demo-v1', phase: 'Available',
    })));
    renderWithProviders(<AgentGuardrails name="demo" visible />);
    expect(await screen.findByText('application-ref')).toBeInTheDocument();
    expect(screen.getByText('Policies: configured')).toBeInTheDocument();
    expect(screen.getByText('Runtime enforcement: unverified')).toBeInTheDocument();
    expect(screen.queryByText('Policies: none attached')).not.toBeInTheDocument();
  });

  it('shows declared audit mode without claiming runtime enforcement', async () => {
    server.use(http.get('*/v1/guardrails', () => HttpResponse.json({
      enabled: true, mode: null, enforcementVerified: false,
      policies: [{ ...platform, bundle: { policies: [{ ...bundle.policies[0], mode: 'audit' }] } }],
    })));
    renderWithProviders(<PlatformGuardrails />);
    expect(await screen.findByText('Declared mode: audit')).toBeInTheDocument();
    expect(screen.getByText(/Runtime enforcement: unverified/)).toBeInTheDocument();
  });

  it('reports unresolved configuration, not an inactive success', async () => {
    server.use(http.get('*/v1/agents/demo/guardrails', () =>
      HttpResponse.json({ detail: 'Unknown agent governance bundle: missing' }, { status: 409 })));
    renderWithProviders(<AgentGuardrails name="demo" visible />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load agent guardrails');
    expect(screen.queryByText('No guardrails attached')).not.toBeInTheDocument();
  });
});
