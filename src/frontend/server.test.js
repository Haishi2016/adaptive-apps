const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NATIVE_AGENT_URL = "http://agent-ingress";
process.env.NATIVE_UI_URL = "http://native-ui";
process.env.OIDC_ISSUER = "https://identity.example/realms/adaptive";
process.env.OIDC_AUTH_ENDPOINT = "https://identity.example/auth";
process.env.OIDC_TOKEN_ENDPOINT = "https://identity.example/token";
process.env.OIDC_USERINFO_ENDPOINT = "https://identity.example/userinfo";
process.env.OIDC_CLIENT_ID = "adaptive-trading";
process.env.OIDC_CLIENT_SECRET = "test-only-client-secret";
const { exactNativeRequest, ensureNativeAuth, serverAccessToken } = require("./server");

function request(method, path, provider = "microsoft") {
  return {
    method,
    path,
    user: { provider },
    isAuthenticated: () => true,
  };
}

test("native API allowlist accepts only inventory and stable response routes", () => {
  for (const [method, path] of [
    ["GET", "/v1/agents"],
    ["GET", "/v1/agents/writer"],
    ["GET", "/v1/agents/writer/spans"],
    ["GET", "/v1/agents/writer/guardrails"],
    ["GET", "/v1/agents/writer/agent-card"],
    ["POST", "/agents/writer/responses"],
  ]) {
    assert.equal(exactNativeRequest(request(method, path)), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ["POST", "/v1/agents"],
    ["PATCH", "/v1/connectivity-fault"],
    ["POST", "/v1/agents/writer/agent-card/validate"],
    ["POST", "/v1/agents/writer/a2a/test-call"],
    ["GET", "/v1/agents/writer/versions"],
    ["GET", "/v1/agents/writer/versions/v1"],
    ["POST", "/agents/writer/versions/v1/responses"],
    ["POST", "/agents/writer/responses/extra"],
    ["GET", "/v1/agents/Writer"],
  ]) {
    assert.equal(exactNativeRequest(request(method, path)), false, `${method} ${path}`);
  }
});

test("local users receive an explicit forbidden response", () => {
  let status;
  let body;
  ensureNativeAuth(request("GET", "/agents", "local"), {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      body = value;
    },
  }, () => assert.fail("local users must not pass"));
  assert.equal(status, 403);
  assert.match(body.error, /OIDC/);
});

test("concurrent requests redeem a rotating refresh token once", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 300,
      }),
    };
  };
  const session = {
    oidcTokens: {
      accessToken: "expired-access",
      refreshToken: "rotating-refresh",
      expiresAt: 0,
    },
    save: (done) => done(),
  };
  const req = { sessionID: "same-session", session };
  try {
    assert.deepEqual(
      await Promise.all([serverAccessToken(req), serverAccessToken(req)]),
      ["new-access", "new-access"]
    );
    assert.equal(calls, 1);
    assert.equal(session.oidcTokens.refreshToken, "new-refresh");
  } finally {
    global.fetch = originalFetch;
  }
});
