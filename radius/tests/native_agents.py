"""Source/render checks; these do not qualify a live ownership handover."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
COMPILER = os.environ.get("BICEP", str(Path.home() / ".rad/bin/bicep"))


class NativeAgents(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.compiled = {}
        for path in [
            "radius/recipes/agents/logical.bicep",
            "radius/recipes/agents/runtime.bicep",
            "radius/recipes/ai-agent/native-model.bicep",
            "radius/recipes/ai-agent/native-model-kaito.bicep",
            "radius/recipes/ai-agent/native-gateway.bicep",
            "radius/recipes/agent-guardrails/native-policy.bicep",
            "radius/agents-env.bicep",
            "radius/foundry-env.bicep",
            "radius/foundry-agent.bicep",
            "radius/agents.bicep",
            "radius/agent-identity.bicep",
            "radius/agent-services.bicep",
            "radius/agent-models.bicep",
            "radius/credentials.bicep",
            "radius/agent-policy.bicep",
            "radius/app.bicep",
        ]:
            target = Path(cls.temp.name) / (path.replace("/", "_") + ".json")
            subprocess.run(
                [COMPILER, "build", str(ROOT / path), "--outfile", str(target)],
                check=True,
                capture_output=True,
                text=True,
            )
            cls.compiled[path] = json.loads(target.read_text())
        values = {
            "features": {"agents": {"enabled": True}},
            "agents": {
            "keycloakService": "agents-keycloak",
            "telemetry": {"enabled": True},
            "runtime": {
                "agentGatewayImage": "agent-gateway@sha256:" + "c" * 64,
                "uiImage": "ui@sha256:" + "a" * 64,
                "apiImage": "api@sha256:" + "b" * 64,
                "issuer": "https://id.example/realms/adaptive",
                "certificateSecret": "ui-tls",
                "environmentJson": '{"name":"fixture","cloud":{"enabled":false}}',
            },
            "modelGateway": {
                "identity": {"clientId": "reviewed-client", "tenantId": "reviewed-tenant"},
                "configs": [{"name": name, "digest": "fixture"}
                            for name in ["local-model", "cloud-model", "hybrid-model"]],
                "authorization": {
                    "issuer": "https://id.example/realms/adaptive",
                    "jwksUrl": "http://keycloak.native-test:8080/realms/adaptive/protocol/openid-connect/certs",
                    "clients": ["adaptive-native-test-writer"],
                    "agentIds": [],
                    "tenantId": "",
                },
            },
            },
        }
        source = Path(cls.temp.name) / "values.yaml"
        source.write_text(yaml.safe_dump(values))
        rendered = subprocess.check_output(
            [
                "helm",
                "template",
                "agents",
                str(ROOT / "charts/adaptive-apps"),
                "--namespace",
                "native-test",
                "-f",
                str(ROOT / "charts/adaptive-apps/profiles/min-ai.yaml"),
                "-f",
                str(source),
            ],
            text=True,
        )
        cls.resources = [obj for obj in yaml.safe_load_all(rendered) if obj]

    def test_only_native_lifecycle_resources(self):
        runtime = self.compiled["radius/recipes/agents/runtime.bicep"]
        resources = runtime["resources"]
        kinds = {entry["type"].split("@")[0] for entry in resources.values()}
        self.assertEqual(
            kinds,
            {
                "core/ConfigMap",
                "core/PersistentVolumeClaim",
                "core/Service",
                "apps/StatefulSet",
                "gateway.networking.k8s.io/HTTPRoute",
                "gateway.envoyproxy.io/SecurityPolicy",
                "gateway.envoyproxy.io/EnvoyExtensionPolicy",
                "networking.k8s.io/NetworkPolicy",
            },
        )
        serialized = json.dumps(runtime)
        self.assertNotIn("adaptive.jplck.io/Agent", serialized)
        self.assertNotIn("CLUSTER_MODE", serialized)
        self.assertNotIn("capture", resources)
        self.assertEqual(resources["workload"]["properties"]["spec"]["replicas"], 1)
        deletion = json.dumps(runtime["outputs"]["result"])
        self.assertNotIn("/PersistentVolumeClaim/", deletion)
        self.assertIn("agentUid", runtime["variables"]["name"])
        self.assertNotIn("version", runtime["variables"]["name"])
        self.assertIn("/agents/{0}", runtime["variables"]["path"])
        self.assertIn("radius.resource.id", serialized)
        self.assertIn("item_ttl_seconds=-1", runtime["variables"]["stateInit"])
        self.assertIn("tryGet(tryGet(variables('p'), 'governance'), 'config')", json.dumps(runtime["variables"]["governanceConfig"]))
        self.assertNotIn("variables('proxy').config", serialized)

    def test_shared_identity_and_collector(self):
        credentials = self.compiled["radius/credentials.bicep"]
        for name in ["graphClientCertificate", "graphClientCertificatePassword"]:
            self.assertEqual(credentials["parameters"][name]["defaultValue"], "")
        self.assertIn("empty(parameters('graphClientCertificate'))", json.dumps(credentials))
        self.assertIn("adaptive-trading-client-secret", json.dumps(credentials))
        deployments = [obj for obj in self.resources if obj["kind"] == "Deployment"]
        keycloak = [obj for obj in deployments if obj["metadata"]["name"].endswith("-keycloak")]
        collector = [obj for obj in deployments if obj["metadata"]["name"] == "otel-collector"]
        gateway = [obj for obj in deployments
                   if obj["metadata"]["name"] == "agent-gateway-policy"]
        self.assertEqual(len(keycloak), 1)
        self.assertEqual(len(collector), 1)
        self.assertEqual(len(gateway), 1)
        self.assertEqual(
            gateway[0]["spec"]["template"]["spec"]["containers"][0]["image"],
            "agent-gateway@sha256:" + "c" * 64,
        )
        container = keycloak[0]["spec"]["template"]["spec"]["containers"][0]
        self.assertIn("--import-realm", container["command"])
        env = {entry["name"]: entry for entry in container["env"]}
        self.assertEqual(env["KC_DB"]["value"], "postgres")
        labels = collector[0]["spec"]["template"]["metadata"]["labels"]
        self.assertEqual(labels["app.kubernetes.io/name"], "otel-collector")
        config = next(obj for obj in self.resources if obj["kind"] == "ConfigMap"
                      and obj["metadata"]["name"] == "otel-collector-config")
        parsed = yaml.safe_load(config["data"]["collector-config.yaml"])
        self.assertEqual(parsed["service"]["pipelines"]["traces"]["exporters"], ["otlp/traces"])
        runtime = self.compiled["radius/recipes/agents/runtime.bicep"]["resources"]
        self.assertIn("app.kubernetes.io/component", json.dumps(runtime))
        catalogue = yaml.safe_load((ROOT / "radius/resource-types/types.yaml").read_text())
        self.assertNotIn("agentPlatforms", catalogue["types"])
        self.assertNotIn("agentReleases", catalogue["types"])
        agent = catalogue["types"]["agents"]["apiVersions"]["2025-08-01-preview"]["schema"]
        self.assertNotIn("releases", agent["properties"])
        self.assertNotIn("activeVersion", agent["properties"])
        self.assertIn("binding", agent["required"])
        self.assertIn("definition", agent["required"])
        model = catalogue["types"]["aiModels"]["apiVersions"]["2025-08-01-preview"]["schema"]
        gateway = catalogue["types"]["aiGateways"]["apiVersions"]["2025-08-01-preview"]["schema"]
        self.assertNotIn("members", model["properties"])
        self.assertIn("members", gateway["properties"])
        login = catalogue["types"]["keycloakLogins"]["apiVersions"]["2025-08-01-preview"]["schema"]
        self.assertIn("tradingOrigin", login["properties"])
        self.assertIn("tradingClientId", login["properties"])

    def test_trading_integration_is_opt_in_and_uses_same_authorization_boundary(self):
        app = self.compiled["radius/app.bicep"]
        self.assertFalse(app["parameters"]["enableNativeAgents"]["defaultValue"])
        self.assertEqual(
            app["resources"]["aiAgentExternal"]["condition"],
            "[and(variables('hasAi'), not(variables('isLocalAi')))]",
        )
        serialized = json.dumps(app)
        self.assertIn("ui-embedded", serialized)
        self.assertIn("NATIVE_AGENT_URL", serialized)
        self.assertIn("NATIVE_UI_URL", serialized)
        self.assertIn("Radius.Resources/agentIdentities", serialized)
        self.assertIn("Radius.Resources/agents", serialized)
        self.assertIn("nativeAgentEnvironment", app["parameters"])
        self.assertIn("nativeAgentModel", app["parameters"])
        self.assertIn("promptAgentImage", app["parameters"])
        self.assertIn("editorAgentImage", app["parameters"])
        for name in ["writerIdentity", "writerAgent", "auditorIdentity", "auditorAgent",
                     "editorIdentity", "editorAgent"]:
            self.assertIn(name, app["resources"])
        policies = "\n".join(
            (ROOT / path).read_text()
            for path in [
                "charts/agent-platform/templates/ui.yaml",
                "charts/agent-platform/templates/model-ingress.yaml",
                "radius/recipes/agents/runtime.bicep",
            ]
        )
        self.assertIn('["adaptive-ui", "adaptive-trading"]', policies)
        self.assertIn("method: 'OPTIONS'", policies)
        self.assertIn("'http://localhost:3000'", policies)
        self.assertIn("'https://localhost:8443'", policies)

    def test_gpu_models_and_keyless_gateway(self):
        model = self.compiled["radius/recipes/ai-agent/native-model.bicep"]
        self.assertEqual(model["resources"], [])
        kaito = self.compiled["radius/recipes/ai-agent/native-model-kaito.bicep"]
        model_kinds = {entry["type"].split("@")[0] for entry in kaito["resources"].values()}
        self.assertEqual(model_kinds, {"core/PersistentVolumeClaim",
                                       "networking.k8s.io/NetworkPolicy", "kaito.sh/Workspace"})

        self.assertNotIn("llama-server", json.dumps(model))
        self.assertNotIn("cpuInference", json.dumps(model))
        gateway_recipe = self.compiled["radius/recipes/ai-agent/native-gateway.bicep"]
        gateway_kinds = {
            entry["type"].split("@")[0] for entry in gateway_recipe["resources"].values()
        }
        self.assertEqual(gateway_kinds, {"core/ConfigMap"})
        self.assertNotIn("OPENAI_API_KEY", json.dumps(model))
        self.assertNotIn("kaito.sh/Workspace", json.dumps(model))
        self.assertIn("os.environ/OPENAI_API_KEY", json.dumps(gateway_recipe))
        gateway = next(obj for obj in self.resources if obj["kind"] == "Deployment"
                       and obj["metadata"]["name"] == "model-gateway")
        pod = gateway["spec"]["template"]["spec"]
        env = {entry["name"]: entry for entry in pod["containers"][0]["env"]}
        self.assertEqual(
            env["OPENAI_API_KEY"]["valueFrom"]["secretKeyRef"],
            {"name": "model-gateway-auth", "key": "openai-api-key", "optional": True},
        )
        self.assertEqual(env["AZURE_CREDENTIAL"]["value"], "WorkloadIdentityCredential")
        self.assertEqual(env["AZURE_CLIENT_ID"]["value"], "reviewed-client")
        self.assertNotIn("AZURE_CLIENT_SECRET", env)
        assertion = next(volume for volume in pod["volumes"] if volume["name"] == "azure-assertion")
        self.assertEqual(assertion["projected"]["sources"][0]["serviceAccountToken"]["audience"],
                         "api://AzureADTokenExchange")
        config = next(obj for obj in self.resources if obj["kind"] == "ConfigMap"
                      and obj["metadata"]["name"] == "model-gateway")
        parsed = yaml.safe_load(config["data"]["config.yaml"])
        self.assertEqual(parsed["include"],
                         ["/etc/models/local-model.yaml", "/etc/models/cloud-model.yaml",
                          "/etc/models/hybrid-model.yaml"])
        self.assertEqual(parsed["router_settings"]["num_retries"], 0)
        declared = self.compiled["radius/agent-models.bicep"]["resources"]
        self.assertEqual(
            declared["hybrid"]["type"],
            "Radius.Resources/aiGateways@2025-08-01-preview",
        )
        self.assertIn("local", json.dumps(declared["hybrid"]))
        self.assertIn("cloud", json.dumps(declared["hybrid"]))

    def test_embedded_ui_uses_native_namespace_for_agent_ingress(self):
        nginx = (ROOT / "src/services/ui/nginx.conf").read_text()
        self.assertIn(
            "agent-ingress.${POD_NAMESPACE}.svc.cluster.local",
            nginx,
        )
        self.assertNotIn("proxy_pass http://agent-ingress:8080", nginx)

    def test_foundry_deployment_is_separate_from_edge(self):
        environment = self.compiled["radius/foundry-env.bicep"]["resources"]
        recipes = environment["environment"]["properties"]["properties"]["recipes"]
        agent_recipe = recipes["Radius.Resources/agents"]["default"]
        self.assertEqual(agent_recipe["templateKind"], "terraform")
        self.assertIn("project_endpoint", agent_recipe["parameters"])
        self.assertNotIn("Radius.Resources/agentReleases", recipes)
        self.assertNotIn("Radius.Resources/agentIdentities", recipes)
        declared = self.compiled["radius/foundry-agent.bicep"]["resources"]
        properties = declared["agent"]["properties"]["properties"]
        self.assertIsNone(properties["binding"])
        self.assertIn("definition", properties)
        self.assertNotIn("releases", properties)
        self.assertNotIn("nativeVersion", self.compiled["radius/foundry-agent.bicep"]["outputs"])
        logical = self.compiled["radius/recipes/agents/logical.bicep"]
        self.assertIn("platform", logical["parameters"])

    def test_ordinary_profiles_do_not_install_another_native_stack(self):
        for profile in ["min", "min-ai", "core", "core-ai", "ent", "ent-ai"]:
            with self.subTest(profile=profile):
                rendered = subprocess.check_output([
                    "helm", "template", "portfolio", str(ROOT / "charts/adaptive-apps"),
                    "-f", str(ROOT / f"charts/adaptive-apps/profiles/{profile}.yaml"),
                ], text=True)
                objects = [obj for obj in yaml.safe_load_all(rendered) if obj]
                self.assertFalse(any(obj["kind"] == "GatewayClass" for obj in objects))
                self.assertFalse(any(obj["metadata"]["name"] == "platform-api" for obj in objects))
                keycloak = next(obj for obj in objects if obj["kind"] == "Deployment"
                                and obj["metadata"]["name"].endswith("-keycloak"))
                pod = keycloak["spec"]["template"]["spec"]
                self.assertNotIn("volumes", pod)
                self.assertNotIn("volumeMounts", pod["containers"][0])
                collectors = [obj for obj in objects if obj["kind"] == "Deployment"
                              and obj["metadata"]["name"] == "otel-collector"]
                self.assertEqual(len(collectors), 0 if profile.startswith("min") else 1)

    def test_direct_admission_boundary(self):
        runtime = self.compiled["radius/recipes/agents/runtime.bicep"]["resources"]
        route = runtime["route"]["properties"]["spec"]["rules"][0]
        self.assertEqual(route["matches"][0]["method"], "POST")
        self.assertEqual(route["matches"][0]["path"]["type"], "Exact")
        self.assertEqual(route["timeouts"], {"request": "0s", "backendRequest": "0s"})
        auth = runtime["authorization"]["properties"]["spec"]["extAuth"]
        self.assertFalse(auth["failOpen"])
        self.assertFalse(auth["recomputeRoute"])
        self.assertEqual(auth["bodyToExtAuth"]["maxRequestBytes"], 1048576)
        proxy = next(obj for obj in self.resources if obj["kind"] == "EnvoyProxy")
        self.assertEqual(
            proxy["spec"]["filterOrder"],
            [
                {"name": "envoy.filters.http.ext_authz", "after": "envoy.filters.http.rbac"},
                {"name": "envoy.filters.http.lua", "after": "envoy.filters.http.ext_authz"},
            ],
        )
        self.assertFalse(any(obj["kind"] == "CustomResourceDefinition" for obj in self.resources))

    def test_fault_is_only_public_egress(self):
        policy = next(
            obj
            for obj in self.resources
            if obj["kind"] == "NetworkPolicy" and obj["metadata"]["name"] == "demo-cloud-egress"
        )
        self.assertEqual(
            policy["spec"]["podSelector"],
            {"matchLabels": {"adaptive.jplck.io/cloud-egress": "true"}},
        )
        self.assertEqual(policy["spec"]["policyTypes"], ["Egress"])
        rules = policy["spec"]["egress"]
        self.assertEqual(rules[0]["ports"], [{"protocol": "TCP", "port": 443}])
        self.assertEqual(
            [peer["ipBlock"]["cidr"] for peer in rules[0]["to"]], ["0.0.0.0/0", "::/0"]
        )
        for obj in self.resources:
            if obj["kind"] == "Role":
                for rule in obj["rules"]:
                    self.assertNotIn("adaptive.jplck.io", rule["apiGroups"])
                    if "patch" in rule["verbs"]:
                        self.assertEqual(rule["resourceNames"], ["demo-cloud-egress"])
                        self.assertEqual(rule["resources"], ["networkpolicies"])
                    if any(
                        name in rule["resources"]
                        for name in ["statefulsets", "configmaps", "services"]
                    ):
                        self.assertTrue(set(rule["verbs"]) <= {"get", "list"})

    def test_namespace_and_native_enforcement(self):
        api = next(
            obj
            for obj in self.resources
            if obj["kind"] == "Deployment" and obj["metadata"]["name"] == "platform-api"
        )
        env = {
            entry["name"]: entry["value"]
            for entry in api["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        self.assertEqual(env["K8S_NAMESPACE"], "native-test")
        self.assertIn(".native-test.svc.", env["TRACE_QUERY_ENDPOINT"])
        policies = [obj for obj in self.resources if obj["kind"] == "ValidatingAdmissionPolicy"]
        self.assertEqual(len(policies), 2)
        self.assertTrue(all(obj["spec"]["failurePolicy"] == "Fail" for obj in policies))
        runtime = next(
            obj for obj in policies if obj["metadata"]["name"].endswith("-agent-runtime")
        )
        self.assertIn(
            "statefulsets/scale",
            runtime["spec"]["matchConstraints"]["resourceRules"][0]["resources"],
        )
        self.assertIn("object.spec.replicas <= 1", runtime["spec"]["validations"][0]["expression"])
        self.assertIn("object.metadata.name", runtime["spec"]["matchConditions"][0]["expression"])
        self.assertEqual(
            runtime["spec"]["variables"],
            [{"name": "isScale", "expression": "has(request.subResource) && request.subResource == 'scale'"}],
        )
        self.assertTrue(
            any(
                "other.name == e.name" in entry["expression"]
                for entry in runtime["spec"]["validations"]
            )
        )
        metadata = next(
            obj for obj in policies if obj["metadata"]["name"].endswith("-agent-metadata")
        )
        lifecycle = metadata["spec"]["validations"][1]["expression"]
        self.assertIn("object.data.identityRef", lifecycle)
        self.assertNotIn("releases", lifecycle)
        self.assertNotIn("activeVersion", lifecycle)
        envs = self.compiled["radius/agents-env.bicep"]["resources"]
        self.assertNotEqual(
            envs["environment"]["properties"]["properties"]["compute"]["namespace"],
            envs["loginEnvironment"]["properties"]["properties"]["compute"]["namespace"],
        )
        recipes = envs["environment"]["properties"]["properties"]["recipes"]
        self.assertNotIn("Radius.Resources/agentReleases", recipes)
        for kind in ["agents", "agentIdentities", "aiModels"]:
            parameters = recipes[f"Radius.Resources/{kind}"]["default"]["parameters"]
            self.assertIn("namespace", json.dumps(parameters))
        model_recipes = recipes["Radius.Resources/aiModels"]
        self.assertEqual(set(model_recipes), {"default", "kaito"})
        self.assertIn("ai-models:0.5.2", model_recipes["default"]["templatePath"])
        self.assertIn("ai-models-kaito:0.5.2", model_recipes["kaito"]["templatePath"])
        services = json.dumps(self.compiled["radius/agent-services.bicep"])
        self.assertIn("'recipe'", services)
        services_source = (ROOT / "radius/agent-services.bicep").read_text()
        self.assertIn("model: entry.name", services_source)
        self.assertNotIn("model: model[index].properties.model", services_source)
        for recipe in ["agents/logical", "agents/runtime", "ai-agent/native-gateway"]:
            compiled = self.compiled[f"radius/recipes/{recipe}.bicep"]
            self.assertIn("namespace", compiled["parameters"])
            self.assertNotIn("runtime.kubernetes.namespace", json.dumps(compiled))


if __name__ == "__main__":
    unittest.main()
