import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('native model development proxy', () => {
  it('ships the complete model base through the nginx model gateway boundary', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const nginx = readFileSync('nginx.conf', 'utf8');
    expect(dockerfile).toMatch(/^ARG VITE_GATEWAY_URL=\/models\/v1$/m);
    expect(dockerfile).toContain('COPY nginx.conf /etc/nginx/templates/default.conf.template');
    expect(dockerfile).toContain('NGINX_ENVSUBST_FILTER=^POD_NAMESPACE$');
    expect(nginx).toContain('location ^~ /models/v1/ {');
    expect(nginx).toContain('set $model_gateway model-ingress.${POD_NAMESPACE}.svc.cluster.local;');
    expect(nginx).toContain('rewrite ^/models(/v1/.*)$ $1 break;');
    expect(nginx).toContain('proxy_pass http://$model_gateway:8080;');
    expect(nginx).toMatch(/location \/v1\/ \{[\s\S]*?proxy_pass http:\/\/\$agent_gateway:8080;/);
    expect(nginx).toMatch(/location ~ \^\/agents\/\[\^\/\]\+\/ \{[\s\S]*?proxy_pass http:\/\/\$agent_gateway:8080;/);
    expect(nginx).not.toContain('/api/projects');
  });

  it('rewrites the browser prefix to the authorized model front door only', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { loadConfigFromFile } from 'vite';
      const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' });
      const proxy = config.server.proxy['/models/v1'];
      console.log(JSON.stringify({
        target: proxy.target,
        inventoryTarget: config.server.proxy['/v1'].target,
        responsesTarget: config.server.proxy['^/agents/[^/]+/'].target,
        proxyPaths: Object.keys(config.server.proxy),
        paths: ['/models/v1/models', '/models/v1/chat/completions', '/models/v1/responses',
                '/models/v10/models', '/v1/agents'].map(proxy.rewrite),
        headers: proxy.headers ?? null,
      }));
    `], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({
      target: 'http://127.0.0.1:8092',
      inventoryTarget: 'http://127.0.0.1:8091',
      responsesTarget: 'http://127.0.0.1:8091',
      proxyPaths: ['/models/v1', '^/agents/[^/]+/', '/v1'],
      paths: ['/v1/models', '/v1/chat/completions', '/v1/responses', '/models/v10/models', '/v1/agents'],
      headers: null,
    });
  });
});
