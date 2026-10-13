function envoy_on_request(handle)
  for name, _ in pairs(handle:headers()) do
    if name:match("^x%-client%-") or name:match("^x%-adaptive%-") or name:match("^x%-ms%-") or name == "x-identity-header" then
      handle:respond({[":status"] = "403"}, "Delegation and identity headers are not supported")
      return
    end
  end
  local mode = handle:headers():get("x-admission-identity-mode")
  if mode ~= "app" and mode ~= "endUserOBO" and mode ~= "agentUser" then
    handle:respond({[":status"] = "403"}, "Verified identity admission is required")
    return
  end
  handle:headers():add("x-client-identity-mode", mode)
  if mode ~= "app" then
    local token = handle:headers():get("x-admission-graph-token")
    local user = handle:headers():get("x-admission-graph-user")
    if not token or token == "" or not user or user == "" then
      handle:respond({[":status"] = "403"}, "Verified Graph delegation is required")
      return
    end
    handle:headers():add("x-client-microsoft-graph-access-token", token)
    handle:headers():add("x-client-graph-user-id", user)
  end
  handle:headers():remove("x-admission-identity-mode")
  handle:headers():remove("x-admission-graph-token")
  handle:headers():remove("x-admission-graph-user")
  handle:headers():remove("authorization")
  handle:headers():remove("cookie")
  handle:headers():remove("x-entra-user-token")
  handle:headers():remove("x-impersonation-mode")
end
