# Prepare a K3s Cluster


1. Install k3d:


    ```bash
    curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

    ```

2.  Verify installation:

    ```bash
    k3d --version
    ```

3. Create a K3s cluster:

    ```bash
    k3d cluster create k3s
    # Set K3D_FIX_DNS=0 helps cluster creation complete in environments where it otherwise stalls at configuring CoreDNS configmap
    ```

    The standard k3s configuration includes the `local-path` dynamic storage
    provisioner and the embedded NetworkPolicy controller. Do not pass
    `--disable-network-policy` when creating a cluster for the integrated
    Kubernetes-hosted portable-agent path.

4. Verify the storage and NetworkPolicy APIs:

    ```bash
    kubectl get storageclass \
      -o custom-columns='NAME:.metadata.name,DEFAULT:.metadata.annotations.storageclass\.kubernetes\.io/is-default-class,PROVISIONER:.provisioner'

    kubectl api-resources \
      --api-group=networking.k8s.io |
      grep networkpolicies
    ```

    The `local-path` class must be marked as the default. API discovery confirms
    that the resource type is available; NetworkPolicy enforcement comes from
    the embedded k3s controller and requires that it was not disabled at cluster
    creation.
