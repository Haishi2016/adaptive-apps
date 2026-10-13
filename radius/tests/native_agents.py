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
            "radius/recipes/agents/release.bicep",
            "radius/recipes/ai-agent/native-gateway.bicep",
            "radius/recipes/agent-guardrails/native-policy.bicep",
            "radius/agents-env.bicep",
            "radius/agents.bicep",
            "radius/agent-identity.bicep",
            "radius/agent-release.bicep",
            "radius/agent-platform.bicep",
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
            "runtime": {
                "uiImage": "ui@sha256:" + "a" * 64,
                "apiImage": "api@sha256:" + "b" * 64,
                "issuer": "https://id.example/realms/adaptive",
                "certificateSecret": "ui-tls",
                "environmentJson": '{"name":"fixture","cloud":{"enabled":false}}',
            },
            "modelGateway": {
                "configs": [{"name": "local-model", "digest": "fixture"}],
                "authorization": {
                    "issuer": "https://id.example/realms/adaptive",
                    "jwksUrl": "http://keycloak.native-test:8080/realms/adaptive/protocol/openid-connect/certs",
                    "clients": ["adaptive-native-test-writer"],
                    "agentIds": [],
                    "tenantId": "",
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
                str(ROOT / "charts/agent-platform"),
                "--namespace",
                "native-test",
                "-f",
                str(source),
            ],
            text=True,
        )
        cls.resources = [obj for obj in yaml.safe_load_all(rendered) if obj]

    def test_only_native_lifecycle_resources(self):
        release = self.compiled["radius/recipes/agents/release.bicep"]
        resources = release["resources"]
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
        serialized = json.dumps(release)
        self.assertNotIn("adaptive.jplck.io/Agent", serialized)
        self.assertNotIn("CLUSTER_MODE", serialized)
        self.assertTrue(resources["capture"]["properties"]["immutable"])
        self.assertEqual(resources["workload"]["properties"]["spec"]["replicas"], 1)
        deletion = json.dumps(release["outputs"]["result"])
        self.assertNotIn("/PersistentVolumeClaim/", deletion)
        self.assertNotIn("/ConfigMap/", deletion)
        self.assertIn("agentUid", release["variables"]["name"])
        self.assertIn("version", release["variables"]["name"])
        self.assertIn("radiusResourceId", serialized)
        self.assertIn("item_ttl_seconds=-1", release["variables"]["stateInit"])

    def test_direct_admission_boundary(self):
        release = self.compiled["radius/recipes/agents/release.bicep"]["resources"]
        route = release["route"]["properties"]["spec"]["rules"][0]
        self.assertEqual(route["matches"][0]["method"], "POST")
        self.assertEqual(route["matches"][0]["path"]["type"], "Exact")
        self.assertEqual(route["timeouts"], {"request": "0s", "backendRequest": "0s"})
        auth = release["authorization"]["properties"]["spec"]["extAuth"]
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
        envs = self.compiled["radius/agents-env.bicep"]["resources"]
        self.assertNotEqual(
            envs["environment"]["properties"]["properties"]["compute"]["namespace"],
            envs["loginEnvironment"]["properties"]["properties"]["compute"]["namespace"],
        )
        recipes = envs["environment"]["properties"]["properties"]["recipes"]
        for kind in ["agents", "agentReleases", "agentIdentities", "aiModels"]:
            parameters = recipes[f"Radius.Resources/{kind}"]["default"]["parameters"]
            self.assertIn("namespace", json.dumps(parameters))
        for recipe in ["agents/logical", "agents/release", "ai-agent/native-gateway"]:
            compiled = self.compiled[f"radius/recipes/{recipe}.bicep"]
            self.assertIn("namespace", compiled["parameters"])
            self.assertNotIn("runtime.kubernetes.namespace", json.dumps(compiled))


if __name__ == "__main__":
    unittest.main()
