/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from '@playwright/test';
import { buildPrompt } from './sessionPromptBuilder';
import type { ExportOptions } from './sessionPromptBuilder';
import type { ActionInContext, NetworkEvent } from '@recorder/actions';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<ActionInContext> = {}): ActionInContext {
  return {
    frame: { pageGuid: 'page1', pageAlias: 'page', framePath: [] },
    action: { name: 'click', selector: '#btn', signals: [], button: 'left', modifiers: 0, clickCount: 1 } as any,
    startTime: 0,
    ...overrides,
  };
}

function makeNavigate(url: string): ActionInContext {
  return makeAction({ action: { name: 'navigate', url, signals: [] } as any });
}

function makeNetworkEvent(overrides: Partial<NetworkEvent>): NetworkEvent {
  return {
    url: 'http://localhost/api/test',
    method: 'GET',
    status: 200,
    bucket: 'direct',
    pageGuid: 'page1',
    firedMs: 10,
    isRedirect: false,
    aborted: false,
    ...overrides,
  };
}

const BASE_OPTIONS: ExportOptions = {
  scenarioName: 'login flow',
  outputFile: '/tmp/tests/login.spec.ts',
  wsEndpoint: 'ws://localhost:9222',
  pageHasWebSockets: false,
};

function makeSession(
  actions: ActionInContext[],
  overrides: { hasWebSockets?: boolean; dataCreatingActions?: number[] } = {}
) {
  return {
    actions,
    warnings: [],
    hasWebSockets: overrides.hasWebSockets ?? false,
    dataCreatingActions: overrides.dataCreatingActions ?? [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('buildPrompt', () => {
  test('single-page session → one segment, no "### Page:" header for nameless segment', () => {
    const actions = [makeAction()];
    const prompt = buildPrompt(makeSession(actions), BASE_OPTIONS);
    expect(prompt).toContain('## Recorded Session');
    expect(prompt).toContain('- click: #btn');
    // No navigate action → no "### Page:" header
    expect(prompt).not.toContain('### Page:');
  });

  test('navigate action creates a new page segment header', () => {
    const actions = [
      makeNavigate('http://localhost/login'),
      makeAction({ action: { name: 'click', selector: '#submit', signals: [], button: 'left', modifiers: 0, clickCount: 1 } as any }),
      makeNavigate('http://localhost/dashboard'),
      makeAction({ action: { name: 'fill', selector: '#search', text: 'hello', signals: [] } as any }),
    ];
    const prompt = buildPrompt(makeSession(actions), BASE_OPTIONS);
    expect(prompt).toContain('### Page: http://localhost/login');
    expect(prompt).toContain('### Page: http://localhost/dashboard');
  });

  test('no networkEvents → valid prompt with no API calls sections', () => {
    const actions = [makeAction()];
    const prompt = buildPrompt(makeSession(actions), BASE_OPTIONS);
    expect(prompt).not.toContain('API calls (direct)');
    expect(prompt).not.toContain('API calls (page load context)');
    // Still has required sections
    expect(prompt).toContain('## Best Practices');
    expect(prompt).toContain('## Output Format');
  });

  test('direct network event → "API calls (direct)" section', () => {
    const action = makeAction({
      networkEvents: [makeNetworkEvent({ bucket: 'direct', method: 'POST', url: '/api/login', status: 200 })],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).toContain('API calls (direct):');
    expect(prompt).toContain('POST /api/login');
    expect(prompt).not.toContain('API calls (page load context)');
  });

  test('pageLoad network event → "API calls (page load context)" section', () => {
    const action = makeAction({
      networkEvents: [makeNetworkEvent({ bucket: 'pageLoad', method: 'GET', url: '/api/employees', status: 200 })],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).toContain('API calls (page load context):');
    expect(prompt).toContain('GET /api/employees');
    expect(prompt).not.toContain('API calls (direct)');
  });

  test('noise and aborted events are not shown in prompt', () => {
    const action = makeAction({
      networkEvents: [
        makeNetworkEvent({ bucket: 'noise', url: '/api/poll' }),
        makeNetworkEvent({ bucket: 'aborted', url: '/api/slow' }),
      ],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).not.toContain('/api/poll');
    expect(prompt).not.toContain('/api/slow');
    expect(prompt).not.toContain('API calls (direct)');
    expect(prompt).not.toContain('API calls (page load context)');
  });

  test('dataCreatingActions → cleanup note in prompt', () => {
    const action = makeAction({
      networkEvents: [makeNetworkEvent({ bucket: 'direct', method: 'POST', url: '/api/employees', status: 201 })],
    });
    const prompt = buildPrompt(makeSession([action], { dataCreatingActions: [0] }), BASE_OPTIONS);
    expect(prompt).toContain('afterEach cleanup');
    expect(prompt).toContain('POST /api/employees');
    expect(prompt).not.toContain('No data was created');
  });

  test('no dataCreatingActions → "No data was created" note', () => {
    const prompt = buildPrompt(makeSession([makeAction()]), BASE_OPTIONS);
    expect(prompt).toContain('No data was created. No cleanup needed.');
  });

  test('hasWebSockets: true → WebSocket note in prompt', () => {
    const prompt = buildPrompt(makeSession([makeAction()], { hasWebSockets: true }), BASE_OPTIONS);
    expect(prompt).toContain('## WebSocket Note');
    expect(prompt).toContain('WebSocket connections');
  });

  test('hasWebSockets: false → no WebSocket note', () => {
    const prompt = buildPrompt(makeSession([makeAction()], { hasWebSockets: false }), BASE_OPTIONS);
    expect(prompt).not.toContain('## WebSocket Note');
  });

  test('## Best Practices block always present', () => {
    const prompt = buildPrompt(makeSession([]), BASE_OPTIONS);
    expect(prompt).toContain('## Best Practices (follow exactly)');
    expect(prompt).toContain('Do NOT use page.waitForTimeout()');
    expect(prompt).toContain('getByRole, getByLabel');
  });

  test('## Output Format section always present with JSON string instruction', () => {
    const prompt = buildPrompt(makeSession([]), BASE_OPTIONS);
    expect(prompt).toContain('## Output Format');
    expect(prompt).toContain('JSON string');
    expect(prompt).toContain('JSON.parse()');
    expect(prompt).toContain("import { test, expect } from '@playwright/test';");
  });

  test('GraphQL operationName appears in prompt alongside URL', () => {
    const action = makeAction({
      networkEvents: [makeNetworkEvent({
        bucket: 'direct', method: 'POST', url: '/graphql',
        operationName: 'LoginUser', status: 200,
      })],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).toContain('(LoginUser)');
    expect(prompt).toContain('/graphql');
  });

  test('body snippet appears truncated in prompt', () => {
    const longBody = 'x'.repeat(300);
    const action = makeAction({
      networkEvents: [makeNetworkEvent({ bucket: 'direct', bodySnippet: longBody })],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).toContain('body:');
    expect(prompt).toContain('...');
  });

  test('scenario name and target file appear in prompt', () => {
    const prompt = buildPrompt(makeSession([]), { ...BASE_OPTIONS, scenarioName: 'employee create' });
    expect(prompt).toContain('Name: employee create');
  });

  test('request body snippet appears as (payload: ...) before → STATUS', () => {
    const action = makeAction({
      networkEvents: [makeNetworkEvent({
        method: 'POST',
        bucket: 'direct',
        requestBodySnippet: '{"email":"user@example.com","password":"[redacted]"}',
        bodySnippet: '{"token":"[redacted]"}',
      })],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).toContain('(payload:');
    expect(prompt).toContain('(body:');
    // payload must appear before → and before response body
    const payloadIdx = prompt.indexOf('(payload:');
    const arrowIdx = prompt.indexOf('→');
    const bodyIdx = prompt.indexOf('(body:');
    expect(payloadIdx).toBeLessThan(arrowIdx);
    expect(arrowIdx).toBeLessThan(bodyIdx);
  });

  test('no payload section when requestBodySnippet absent', () => {
    const action = makeAction({
      networkEvents: [makeNetworkEvent({ method: 'GET', bucket: 'direct', bodySnippet: '{"items":[]}' })],
    });
    const prompt = buildPrompt(makeSession([action]), BASE_OPTIONS);
    expect(prompt).not.toContain('(payload:');
    expect(prompt).toContain('(body:');
  });
});

// Note: exportSession integration tests (chat.post null, etc.) require the compiled bundle
// and are exercised via the recorderApp.integration tests instead.
