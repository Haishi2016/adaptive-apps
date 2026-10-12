# Adaptive AI components

As AI and agentic systems become deeply integrated into traditional applications, the Adaptive Apps story isn't complete without addressing the adaptability of AI components. This document provides an overview of how Adaptive Apps support the adaptability of AI-related components, including agents, AI models, guardrails, identities, and more.

> **NOTE:** This is a rapidly evolving area. We'll do our best to keep pace with the changing ecosystem. Our focus, however, is primarily on invariant concepts, providing a relatively stable foundation for the design, development, and continuous operation of AI-powered applications.

## Adaptive Apps Abstractions

From an Adaptive Apps perspective, an agent is a containerized compute unit that typically depends on an external AI model and may also depend on an underlying agent runtime. In enterprise environments, an agent's lifecycle is often managed through an agent control plane, while its identity may be integrated with an enterprise identity system. Agents may also be subject to policies at different scopes, such as system-wide, agent-specific, or context-specific policies.

Our abstractions explicitly exclude the agent runtime and agent control plane, which we consider platform and infrastructure concerns. Instead of reimplementing these capabilities, Adaptive Apps delegate lifecycle management to the corresponding control planes through their APIs.

We define the following resource types:

| Resource Type | Comments |
|--------|--------|
| `agents` | Defines the deployable agent executable and its runtime configuration, including the container artifact and the configuration required to instantiate the agent on a supported agent platform. |
| `agentIdenity` | Defines the identity associated with an agent. The actual identity is typically provisioned and managed by an external identity system; this resource captures the association needed by the application. |
| `aiModels` | Defines the AI model dependency used by an agent, decoupling the agent from a specific model deployment so that model selection and configuration can evolve independently from the agent executable. | 
| `agentGuardrails` | Defines policy and behavioral constraints applied to an agent, potentially at different scopes. The resource represents the desired guardrail configuration, while enforcement may be delegated to the underlying agent platform, model platform, or another policy enforcement mechanism. |

## Agents



## Agent Identities

## AI Models

## Agent Guardrails
