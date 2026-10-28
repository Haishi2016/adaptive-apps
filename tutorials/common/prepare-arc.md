# Prepare an Azure Arc-enabled Cluster

This is the Arc preparation step for the existing
[getting-started flow](../getting-started/README.md). Arc is host/platform
preparation, not an application recipe or agent lifecycle controller.
`ada bootstrap --platform arc` consumes the selected cluster; it does not
onboard it or configure its Kubernetes token issuer.

## Prerequisites

- A reachable Kubernetes cluster, trusted kubeconfig, enforcing CNI and
  persistent storage. Use the existing [K3s](prepare-k3s.md) or
  [Azure Local](prepare-azure-local.md) guide as appropriate.
- Azure CLI with the `connectedk8s` extension and authorized access to the exact
  subscription/resource group. Install missing tools through their normal
  package/extension mechanism.
- Outbound access required by
  [Azure Arc](https://learn.microsoft.com/azure/azure-arc/kubernetes/network-requirements).
  Installation/onboarding is connected work, not offline provisioning.
- An explicitly selected Arc resource name. Do not attach a new cluster to
  somebody else's registration or delete an existing resource by display name.

## Connect the cluster

Set reviewed, non-secret identifiers and select the trusted kubeconfig:

```bash
export KUBECONFIG=<trusted-cluster-kubeconfig>
export RESOURCE_GROUP=<existing-resource-group>
export CLUSTER_NAME=<new-owned-Arc-cluster-name>
kubectl get nodes
az account show --query '{subscription:id,tenant:tenantId}' -o table
```

For a new cluster that needs Entra workload federation:

```bash
az connectedk8s connect \
  --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP" \
  --kube-config "$KUBECONFIG" \
  --enable-oidc-issuer --enable-workload-identity \
  --disable-auto-upgrade
```

For the same already-owned cluster, enable missing features with
`az connectedk8s update --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP"
--enable-oidc-issuer --enable-workload-identity`; do not create a second owner.
The OIDC/WI flags are currently preview in the CLI. Explicit agent upgrades
remain an operator responsibility when automatic upgrades are disabled.

## Configure the actual Kubernetes signer

Enabling Arc's issuer endpoint alone does not change the API server's token
issuer. Retrieve the exact URL, including its trailing slash:

```bash
export OIDC_ISSUER="$(az connectedk8s show \
  --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP" \
  --query oidcIssuerProfile.issuerUrl -o tsv)"
test -n "$OIDC_ISSUER"
```

On a systemd-managed K3s host, add the following configuration using the
returned value to a reviewed file under `/etc/rancher/k3s/config.yaml.d/`:

```yaml
kube-apiserver-arg:
  - service-account-issuer=<exact-Arc-OIDC-issuer>
  - service-account-max-token-expiration=24h
```

Review existing API server arguments rather than replacing unrelated
configuration. Restart only that host's `k3s` service. Other Kubernetes
distributions require their supported API server configuration mechanism;
this host step does not apply inside a k3d container.

**Do this before installing Radius and applications.** Pods created before
the issuer change can retain projected assertions with the former issuer and
receive Kubernetes `Unauthorized` errors. If preparation order was reversed,
perform a deliberate rollout of the affected bootstrap controllers and verify
their API access. Do not retain the old issuer as a compatibility workaround.

## Verify federation prerequisites

```bash
az connectedk8s show --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP" \
  --query '{state:provisioningState,connectivity:connectivityStatus,oidc:oidcIssuerProfile.enabled,issuer:oidcIssuerProfile.issuerUrl,workloadIdentity:securityProfile.workloadIdentity.enabled}'
kubectl get --raw /.well-known/openid-configuration
curl --fail --silent --show-error \
  "${OIDC_ISSUER}.well-known/openid-configuration"
kubectl -n arc-workload-identity rollout status \
  deployment/azure-wi-webhook-controller-manager --timeout=180s
```

The cluster and public discovery documents must report the same exact issuer;
fetch the public discovery document's `jwks_uri` with TLS verification and
confirm that it publishes signing keys. Never disable certificate verification
to make the check pass. `Connected` alone does not prove federation.

Workload credentials must then use an exact federated subject
`system:serviceaccount:<namespace>:<service-account>` and audience
`api://AzureADTokenExchange`. Verify an actual token exchange at the downstream
service, not just the presence of a webhook, annotation or projected file.

For native agents, only the official Entra sidecar receives the blueprint
assertion. The agent uses Keycloak for platform calls, not the blueprint
credentials. See [native agent delivery](../../docs/agents/native-radius.md).
Cloud-only tokens/services remain unavailable during an outage; local paired
identity is a separate mechanism, not a substitute cloud actor.

After these checks, return to
[§2 Bring up the platform](../getting-started/README.md#2-bring-up-the-platform).
For the optional native agent capability, use its Radius-owned delivery branch
instead of installing a second owner over the same shared identity/ingress.

Reference:
[Configure Arc workload identity](https://learn.microsoft.com/azure/azure-arc/kubernetes/workload-identity).
