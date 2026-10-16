import { expect, test } from '@playwright/test';

for (const agent of ['handoff-service', 'trip-scout']) {
  test(`${agent} guardrails show every row of multi-rule policies`, async ({ page }) => {
    await page.addInitScript((name) => {
      const bundle = {
        policies: ['local-models', 'block-pii', 'block-prompt-injection'].map((policy) => ({
          apiVersion: 'governance.toolkit/v1',
          name: policy,
          default_action: 'deny',
          rules: ['pre_input', 'pre_tool'].map((stage) => ({
            name: stage === 'pre_input' ? 'clean-model-input' : 'clean-tool-arguments',
            stage,
            condition: "prompt_injection == 'clear'",
            action: 'allow',
            description: '',
          })),
        })),
      };
      const resource = {
        reference: `adaptive-guardrails-platform/guardrail-${'a'.repeat(24)}@sha256:${'b'.repeat(64)}`,
        namespace: 'adaptive-guardrails-platform',
        targets: ['adaptive/*'],
        bundle,
      };
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes(`/v1/agents/${name}/guardrails`)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                name,
                version: '1',
                enabled: true,
                mode: 'audit',
                inherited: [resource],
                attached: { ...resource, namespace: 'adaptive-guardrails-apps', targets: [] },
                policy_sha256: 'digest',
                deployment: `${name}-v1`,
                phase: 'Available',
              }),
              { headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return fetch(input, init);
      };
    }, agent);
    await page.goto('/agents');
    await page.getByText(agent, { exact: true }).click();
    await page.getByRole('tab', { name: 'Guardrails' }).click();
    const panel = page.getByRole('region', { name: 'Agent guardrails' });
    await expect(panel.getByRole('table')).toHaveCount(2);
    for (const height of [900, 650]) {
      await page.setViewportSize({ width: 1280, height });
      for (const table of await panel.getByRole('table').all()) {
        await table.scrollIntoViewIfNeeded();
        await expect(table.getByRole('row')).toHaveCount(7);
        const geometry = await table.evaluate((element) => {
          const wrapper = element.parentElement!;
          const cells = Array.from(element.querySelectorAll('th, td'));
          wrapper.scrollLeft = 100;
          return {
            tableBottom: element.getBoundingClientRect().bottom,
            wrapperBottom: wrapper.getBoundingClientRect().bottom,
            overflowingCells: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
              .length,
            wrappingCells: cells.filter((cell) => getComputedStyle(cell).whiteSpace !== 'nowrap')
              .length,
            fontSizes: [...new Set(cells.map((cell) => getComputedStyle(cell).fontSize))],
            bodyFontSize: getComputedStyle(element.closest('.fui-FluentProvider')!).fontSize,
            scrollLeft: wrapper.scrollLeft,
          };
        });
        expect(geometry.tableBottom).toBeLessThanOrEqual(geometry.wrapperBottom);
        expect(geometry.overflowingCells).toBe(0);
        expect(geometry.wrappingCells).toBe(0);
        expect(geometry.fontSizes).toEqual([geometry.bodyFontSize]);
        expect(geometry.scrollLeft).toBeGreaterThan(0);
      }
    }
  });

  test(`${agent} monitor shares one telemetry table and resizable details`, async ({ page }) => {
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!/\/v1\/agents\/[^/]+\/spans$/.test(url)) return fetch(input, init);
        let receive: (event: Event) => void;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            receive = (event) => controller.enqueue(new TextEncoder().encode(
              `data: ${(event as CustomEvent<string>).detail}\n\n`,
            ));
            window.addEventListener('monitor-test-record', receive);
            init?.signal?.addEventListener('abort', () => {
              window.removeEventListener('monitor-test-record', receive);
              controller.close();
            }, { once: true });
          },
          cancel() {
            window.removeEventListener('monitor-test-record', receive);
          },
        });
        return Promise.resolve(new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        }));
      };
    });
    await page.goto('/agents');
    await page.getByText(agent, { exact: true }).click();
    await page.getByRole('tab', { name: 'Monitor' }).click();
    const monitor = page.getByRole('region', { name: 'Agent monitor' });
    const pane = monitor.locator('.monitor-table-wrap');
    const table = monitor.getByRole('table', { name: 'Monitor telemetry' });
    const assertContained = async (): Promise<void> => {
      await expect(pane).toHaveCount(1);
      await expect(monitor.getByRole('table')).toHaveCount(1);
      const body = await pane.boundingBox();
      const bounds = await monitor.boundingBox();
      expect(body!.height).toBeGreaterThan(100);
      expect(body!.y + body!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    };
    await assertContained();
    const emptyHeight = (await pane.boundingBox())!.height;
    await page.evaluate(() => {
      for (let index = 0; index < 205; index += 1) {
        const record =
          index % 3 === 0
            ? {
                trace_id: 'layout-trace',
                span_id: String(index),
                parent_span_id: null,
                name: `span-${index}`,
                kind: 'internal',
                service: 'agent',
                start_time_iso: '2026-06-05T13:31:00Z',
                end_time_iso: '2026-06-05T13:31:01Z',
                duration_ms: 1000,
                status: 'ok',
                status_message: null,
                attributes: {},
                events: [],
              }
            : {
                type: 'log',
                log_id: String(index),
                name: index % 3 === 1 ? 'guardrail.decision' : 'identity.reconciliation',
                trace_id: 'layout-trace',
                span_id: '',
                time_iso: '2026-06-05T13:31:00Z',
                severity: 'warning',
                service: index % 3 === 1 ? 'governance-sidecar' : 'agent-ingress',
                attributes:
                  index % 3 === 1
                    ? { 'guardrail.decision': 'deny', 'guardrail.enforced': false }
                    : { 'identity.mode': 'connected', 'identity.result': 'pending' },
              };
        window.dispatchEvent(
          new CustomEvent('monitor-test-record', { detail: JSON.stringify(record) }),
        );
      }
    });
    await expect(table.locator('.monitor-row')).toHaveCount(200);
    await expect(table.getByTitle('identity.reconciliation').first()).toBeVisible();
    await expect(table.getByTitle('guardrail.decision').first()).toBeVisible();
    await expect(table.getByTitle('span-204')).toBeVisible();
    await expect(table.getByTitle('span-0')).toHaveCount(0);
    await assertContained();
    expect(Math.abs((await pane.boundingBox())!.height - emptyHeight)).toBeLessThanOrEqual(1);

    await table.getByTitle('identity.reconciliation').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('Log details', { exact: true })).toBeVisible();
    const handle = drawer.getByRole('separator', { name: 'Resize telemetry details' });
    await handle.hover();
    const before = (await drawer.boundingBox())!.width;
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
    await page.mouse.down();
    await page.mouse.move(grip.x - 150, grip.y + 100, { steps: 5 });
    await page.mouse.up();
    const after = (await drawer.boundingBox())!.width;
    expect(after - before).toBeGreaterThan(140);
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    expect(Math.abs((await drawer.boundingBox())!.width - (after - 40))).toBeLessThanOrEqual(1);
    await drawer.getByRole('button', { name: 'Close telemetry details' }).click();
    await table.getByTitle('span-204').click();
    await expect(drawer.getByText('Span details', { exact: true })).toBeVisible();
    expect(Math.abs((await drawer.boundingBox())!.width - (after - 40))).toBeLessThanOrEqual(1);
    await drawer.getByRole('button', { name: 'Close telemetry details' }).click();

    expect(await pane.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await pane.evaluate((element) => {
      element.scrollTop = 100;
    });
    expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1100, height: 650 });
    await assertContained();
    await monitor.getByRole('button', { name: 'Clear' }).click();
    await expect(monitor.locator('.monitor-row, details')).toHaveCount(0);
    await assertContained();
  });
}

test('models and prompt-agent smoke flow', async ({ page }) => {
  await page.goto('/models');

  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveText([
    'Agents', 'Tools', 'Models', 'Guardrails',
  ]);
  await expect(page.getByText('qwen2.5-7b-instruct')).toBeVisible();
  await expect(page.getByRole('button', { name: /add|create|delete/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Playground' }).first().click();
  await expect(page).toHaveURL(/\/models\/.+\/playground/);

  await page.getByPlaceholder('Chat with the model...').fill('Hello model');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/Mock model response/)).toBeVisible();

  await page.goto('/agents');
  await expect(page.getByText('handoff-service')).toBeVisible();
  await expect(page.getByRole('button', { name: /create|new prompt|delete/i })).toHaveCount(0);
  await page.getByText('handoff-service', { exact: true }).click();
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Invocation release')).toBeEnabled();
  await expect(page.getByText(/Stateless requests/)).toBeVisible();
  await page.getByLabel('Message the agent...').fill('Hello agent');
  await page.getByRole('tab', { name: 'Guardrails' }).click();
  await expect(page.getByText('No guardrails attached')).toBeVisible();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByLabel('Message the agent...')).toHaveValue('Hello agent');
  const firstRequest = page.waitForRequest((request) => request.url().includes('/agents/handoff-service/responses'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Mock response/)).toBeVisible();
  expect((await firstRequest).postDataJSON()).toEqual({
    input: 'Hello agent', store: false, stream: true,
  });
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(page.getByText('Conversation release 1')).toBeVisible();
  await expect(page.getByLabel('Invocation release')).toBeDisabled();
  const secondRequest = page.waitForRequest((request) => request.url().includes('/agents/handoff-service/responses'));
  await page.getByLabel('Message the agent...').fill('Continue');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await secondRequest).postDataJSON()).toEqual({
    input: 'Continue', store: false, stream: true,
  });

  await page.getByRole('link', { name: 'Guardrails', exact: true }).click();
  await expect(page).toHaveURL(/\/guardrails$/);
  await expect(page.getByText('No policy resources configured.')).toBeVisible();
});
