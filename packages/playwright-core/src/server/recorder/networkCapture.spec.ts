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

import { EventEmitter } from 'events';
import { test, expect } from '@playwright/test';
import { NetworkCapture } from './networkCapture';
import type { NetworkCaptureContext } from './networkCapture';
import type { ActionInContext } from '@recorder/actions';

// Mirror of CTX_EVENTS in networkCapture.ts (same string values as BrowserContext.Events.*)
const CTX_EVENTS = {
  Request: 'request',
  RequestFinished: 'requestfinished',
  RequestFailed: 'requestfailed',
  RequestAborted: 'requestaborted',
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

type MockContext = NetworkCaptureContext & EventEmitter;

/** Create a minimal EventEmitter satisfying NetworkCaptureContext. */
function makeMockContext(): MockContext {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  return ee as MockContext;
}

/** Create a mock request object. */
function makeRequest(overrides: {
  guid?: string;
  url?: string;
  method?: string;
  pageGuid?: string;
  redirectedFrom?: object | null;
  postDataBuffer?: Buffer | null;
} = {}) {
  const {
    guid = 'req-' + Math.random(),
    url = 'http://localhost/api/test',
    method = 'GET',
    pageGuid = 'page-1',
    redirectedFrom = null,
    postDataBuffer = null,
  } = overrides;
  return {
    guid,
    url: () => url,
    method: () => method,
    frame: () => pageGuid ? { _page: { guid: pageGuid } } : null,
    redirectedFrom: () => redirectedFrom,
    postDataBuffer: () => postDataBuffer,
  } as any;
}

/** Create a mock response object. */
function makeResponse(overrides: {
  status?: number;
  contentType?: string;
  body?: string;
} = {}) {
  const {
    status = 200,
    contentType = 'application/json',
    body = '{}',
  } = overrides;
  return {
    status: () => status,
    headers: () => [{ name: 'content-type', value: contentType }],
    body: () => Promise.resolve(Buffer.from(body)),
  } as any;
}

/** Build a NetworkCapture + mock context, ready to use with one pre-registered action. */
function makeCapture(pageGuid = 'page-1') {
  const ctx = makeMockContext();
  const delegate = { events: 0, onNetworkEventsUpdated() { this.events++; } };
  const nc = new NetworkCapture(ctx, delegate);
  nc.start();
  const action: ActionInContext = {
    frame: { pageGuid, pageAlias: 'page', framePath: [] },
    action: { name: 'click', selector: '#btn', signals: [], button: 'left', modifiers: 0, clickCount: 1 } as any,
    startTime: Date.now(),
  };
  nc.onActionAdded(action);
  return { ctx, nc, delegate, action };
}

/** Fire a request and its finished event, wait for async body read. */
async function fireRequest(
  ctx: MockContext,
  req: ReturnType<typeof makeRequest>,
  res?: ReturnType<typeof makeResponse>
) {
  ctx.emit(CTX_EVENTS.Request, req);
  if (res !== undefined) {
    ctx.emit(CTX_EVENTS.RequestFinished, { request: req, response: res });
    // Wait for async _onRequestFinished to complete
    await new Promise(r => setTimeout(r, 0));
  }
}

// ─── Noise pre-filter tests ───────────────────────────────────────────────────

test.describe('NetworkCapture — noise pre-filter', () => {
  test('OPTIONS method → noise', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ method: 'OPTIONS' });
    await fireRequest(ctx, req, makeResponse());
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].bucket).toBe('noise');
  });

  test('static asset (.js) → noise', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ url: 'http://localhost/bundle.js' });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].bucket).toBe('noise');
  });

  test('analytics domain → noise', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ url: 'https://analytics.example.com/collect' });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].bucket).toBe('noise');
  });

  test('token refresh URL → noise', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ url: 'http://localhost/api/auth/refresh', method: 'POST' });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].bucket).toBe('noise');
  });

  test('empty pageGuid (service worker) → noise, not attached to action', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ url: 'http://localhost/api/data', pageGuid: '' });
    await fireRequest(ctx, req, makeResponse());
    // targetAction is null for noise with no page → not pushed to action
    expect(action.networkEvents ?? []).toHaveLength(0);
  });

  test('request from unknown page → noise, not attached to action', async () => {
    const { ctx, action } = makeCapture('page-known');
    const req = makeRequest({ url: 'http://localhost/api/data', pageGuid: 'page-unknown' });
    await fireRequest(ctx, req, makeResponse());
    expect(action.networkEvents ?? []).toHaveLength(0);
  });

  test('polling: 3rd call to same URL on same page → noise', () => {
    const { ctx, action } = makeCapture();
    const url = 'http://localhost/api/poll';
    for (let i = 0; i < 3; i++) {
      const req = makeRequest({ url, guid: `poll-req-${i}` });
      ctx.emit(CTX_EVENTS.Request, req);
      // Trigger phase 2 synchronously via abort so the event is pushed to action.networkEvents
      ctx.emit(CTX_EVENTS.RequestAborted, req);
    }
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(3);
    // First two are direct (not noise), third is noise
    expect(events[0].bucket).not.toBe('noise');
    expect(events[1].bucket).not.toBe('noise');
    expect(events[2].bucket).toBe('noise');
  });

  test('polling: two different GraphQL operationNames do not combine for polling', () => {
    const { ctx, action } = makeCapture();
    const gqlUrl = 'http://localhost/graphql';
    const makeGqlBody = (op: string) => Buffer.from(JSON.stringify({ operationName: op, query: '{}' }));
    // 3 calls of GetEmployees: 3rd should be noise
    for (let i = 0; i < 3; i++) {
      const req = makeRequest({ url: gqlUrl, method: 'POST', guid: `gql-get-${i}`, postDataBuffer: makeGqlBody('GetEmployees') });
      ctx.emit(CTX_EVENTS.Request, req);
      ctx.emit(CTX_EVENTS.RequestAborted, req);
    }
    // 1 call of CreateEmployee: should NOT be noise (different op)
    const req = makeRequest({ url: gqlUrl, method: 'POST', guid: 'gql-create', postDataBuffer: makeGqlBody('CreateEmployee') });
    ctx.emit(CTX_EVENTS.Request, req);
    ctx.emit(CTX_EVENTS.RequestAborted, req);

    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(4);
    expect(events[2].bucket).toBe('noise');     // GetEmployees 3rd call
    expect(events[3].bucket).not.toBe('noise'); // CreateEmployee 1st call
  });
});

// ─── Bucket assignment ────────────────────────────────────────────────────────

test.describe('NetworkCapture — bucket assignment', () => {
  test('request after action, no nav signal → direct', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    await fireRequest(ctx, req, makeResponse());
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].bucket).toBe('direct');
    expect(events[0].method).toBe('GET');
    expect(events[0].status).toBe(200);
  });

  test('request within 800ms after nav signal → pageLoad', async () => {
    const { ctx, nc, action } = makeCapture();
    nc.onNavigationSignal('page-1', 'http://localhost/dashboard');
    // Emit immediately — within 800ms window
    const req = makeRequest();
    await fireRequest(ctx, req, makeResponse());
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].bucket).toBe('pageLoad');
  });

  test('click-triggered nav → 1500ms page-load window (fromClick=true)', () => {
    const ctx = makeMockContext();
    const delegate = { onNetworkEventsUpdated() {} };
    const nc = new NetworkCapture(ctx, delegate);
    nc.start();
    const clickAction: ActionInContext = {
      frame: { pageGuid: 'page-1', pageAlias: 'page', framePath: [] },
      action: { name: 'click', selector: '#link', signals: [], button: 'left', modifiers: 0, clickCount: 1 } as any,
      startTime: Date.now(),
    };
    nc.onActionAdded(clickAction);
    // Click-triggered nav → 1500ms window (last action was a click)
    nc.onNavigationSignal('page-1', 'http://localhost/next');
    const req = makeRequest();
    ctx.emit(CTX_EVENTS.Request, req);
    // Trigger phase 2 synchronously via abort to push event to action.networkEvents
    ctx.emit(CTX_EVENTS.RequestAborted, req);
    expect(clickAction.networkEvents?.[0].bucket).toBe('pageLoad');
  });

  test('requestFailed → aborted=true on the network event', () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    ctx.emit(CTX_EVENTS.Request, req);
    ctx.emit(CTX_EVENTS.RequestFailed, req);
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].aborted).toBe(true);
  });

  test('requestAborted → aborted=true on the network event', () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    ctx.emit(CTX_EVENTS.Request, req);
    ctx.emit(CTX_EVENTS.RequestAborted, req);
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].aborted).toBe(true);
  });

  test('unknown request in finished event → no crash and no event added', async () => {
    const { ctx, action } = makeCapture();
    // Finished without prior Request event
    const req = makeRequest();
    ctx.emit(CTX_EVENTS.RequestFinished, { request: req, response: makeResponse() });
    await new Promise(r => setTimeout(r, 0));
    expect(action.networkEvents ?? []).toHaveLength(0);
  });

  test('redirect chain: follow-up request inherits parent bucket', async () => {
    const { ctx, action } = makeCapture();
    const parent = makeRequest({ guid: 'parent-req', url: 'http://localhost/api/login', method: 'POST' });
    ctx.emit(CTX_EVENTS.Request, parent);

    // Child request has redirectedFrom pointing to parent
    const child = makeRequest({ guid: 'child-req', url: 'http://localhost/api/login2', method: 'GET', redirectedFrom: parent });
    ctx.emit(CTX_EVENTS.Request, child);

    // Finish the child
    ctx.emit(CTX_EVENTS.RequestFinished, { request: child, response: makeResponse() });
    await new Promise(r => setTimeout(r, 0));

    // Child should inherit parent's direct bucket, isRedirect=true
    const redirectEvents = (action.networkEvents ?? []).filter(e => e.isRedirect);
    expect(redirectEvents).toHaveLength(1);
    expect(redirectEvents[0].bucket).toBe('direct');
  });

  test('phase 1 bucket is preserved in phase 2 (not re-evaluated)', async () => {
    const { ctx, nc, action } = makeCapture();
    // Set a nav signal to open a pageLoad window
    nc.onNavigationSignal('page-1', 'http://localhost/');
    // Emit request (phase 1) — within window → pageLoad
    const req = makeRequest({ guid: 'check-req' });
    ctx.emit(CTX_EVENTS.Request, req);
    // Even if window expires by phase 2, bucket should stay pageLoad
    ctx.emit(CTX_EVENTS.RequestFinished, { request: req, response: makeResponse() });
    await new Promise(r => setTimeout(r, 0));
    expect(action.networkEvents?.[0].bucket).toBe('pageLoad');
  });
});

// ─── Response body / status ───────────────────────────────────────────────────

test.describe('NetworkCapture — response details', () => {
  test('JSON response body captured as bodySnippet', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    await fireRequest(ctx, req, makeResponse({ body: '{"ok":true}', contentType: 'application/json' }));
    expect(action.networkEvents?.[0].bodySnippet).toBe('{"ok":true}');
  });

  test('binary content-type: body NOT captured', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    await fireRequest(ctx, req, makeResponse({ contentType: 'image/png', body: 'binary' }));
    expect(action.networkEvents?.[0].bodySnippet).toBeUndefined();
  });

  test('response body longer than 500 chars is truncated', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    const longBody = 'x'.repeat(1000);
    await fireRequest(ctx, req, makeResponse({ body: longBody, contentType: 'text/plain' }));
    expect(action.networkEvents?.[0].bodySnippet).toHaveLength(500);
  });

  test('response.body() throwing (3xx redirect) is handled gracefully', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest();
    const failingResponse = {
      status: () => 302,
      headers: () => [{ name: 'content-type', value: 'text/html' }],
      body: () => Promise.reject(new Error('body not available for redirect')),
    };
    ctx.emit(CTX_EVENTS.Request, req);
    ctx.emit(CTX_EVENTS.RequestFinished, { request: req, response: failingResponse });
    await new Promise(r => setTimeout(r, 10));
    const events = action.networkEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(302);
    expect(events[0].bodySnippet).toBeUndefined();
  });

  test('GraphQL operationName extracted from POST body', async () => {
    const { ctx, action } = makeCapture();
    const body = Buffer.from(JSON.stringify({ operationName: 'LoginUser', query: 'mutation {}' }));
    const req = makeRequest({ url: 'http://localhost/graphql', method: 'POST', postDataBuffer: body });
    await fireRequest(ctx, req, makeResponse());
    expect(action.networkEvents?.[0].operationName).toBe('LoginUser');
  });

  test('non-GraphQL POST: no operationName', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ url: 'http://localhost/api/login', method: 'POST' });
    await fireRequest(ctx, req, makeResponse());
    expect(action.networkEvents?.[0].operationName).toBeUndefined();
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

test.describe('NetworkCapture — lifecycle', () => {
  test('waitForPendingResponses resolves immediately when no pending', async () => {
    const { nc } = makeCapture();
    const start = Date.now();
    await nc.waitForPendingResponses(1000);
    expect(Date.now() - start).toBeLessThan(200);
  });

  test('waitForPendingResponses resolves at deadline when requests stay pending', async () => {
    const { ctx, nc } = makeCapture();
    const req = makeRequest();
    ctx.emit(CTX_EVENTS.Request, req);
    // Don't emit RequestFinished — request stays pending
    const start = Date.now();
    await nc.waitForPendingResponses(100);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  test('stop() removes all event listeners', () => {
    const ctx = makeMockContext();
    const delegate = { onNetworkEventsUpdated() {} };
    const nc = new NetworkCapture(ctx, delegate);
    nc.start();
    expect(ctx.listenerCount(CTX_EVENTS.Request)).toBeGreaterThan(0);
    nc.stop();
    expect(ctx.listenerCount(CTX_EVENTS.Request)).toBe(0);
  });

  test('delegate.onNetworkEventsUpdated is called when a request finishes', async () => {
    const { ctx, delegate } = makeCapture();
    const req = makeRequest();
    await fireRequest(ctx, req, makeResponse());
    expect(delegate.events).toBeGreaterThan(0);
  });

  test('getEnrichedActions returns collapsed array with mutated events', async () => {
    const { ctx, nc, action } = makeCapture();
    const req = makeRequest();
    await fireRequest(ctx, req, makeResponse());
    const enriched = nc.getEnrichedActions([action]);
    expect(enriched[0].networkEvents).toHaveLength(1);
  });
});

// ─── Request body capture tests ───────────────────────────────────────────────

test.describe('NetworkCapture — request body capture', () => {
  test('POST with JSON body → requestBodySnippet captured', async () => {
    const { ctx, action } = makeCapture();
    const body = JSON.stringify({ email: 'user@example.com', password: 'secret' });
    const req = makeRequest({ method: 'POST', url: 'http://localhost/api/login', postDataBuffer: Buffer.from(body) });
    await fireRequest(ctx, req, makeResponse());
    const event = (action.networkEvents ?? [])[0];
    expect(event.bucket).toBe('direct');
    expect(event.requestBodySnippet).toBe(body);
  });

  test('PUT with body → requestBodySnippet captured', async () => {
    const { ctx, action } = makeCapture();
    const body = JSON.stringify({ name: 'Alice' });
    const req = makeRequest({ method: 'PUT', url: 'http://localhost/api/users/1', postDataBuffer: Buffer.from(body) });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].requestBodySnippet).toBe(body);
  });

  test('PATCH with body → requestBodySnippet captured', async () => {
    const { ctx, action } = makeCapture();
    const body = JSON.stringify({ role: 'Manager' });
    const req = makeRequest({ method: 'PATCH', url: 'http://localhost/api/users/1', postDataBuffer: Buffer.from(body) });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].requestBodySnippet).toBe(body);
  });

  test('DELETE with body → requestBodySnippet captured', async () => {
    const { ctx, action } = makeCapture();
    const body = JSON.stringify({ ids: [1, 2, 3] });
    const req = makeRequest({ method: 'DELETE', url: 'http://localhost/api/users', postDataBuffer: Buffer.from(body) });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].requestBodySnippet).toBe(body);
  });

  test('DELETE without body → no requestBodySnippet', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ method: 'DELETE', url: 'http://localhost/api/users/3', postDataBuffer: null });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].requestBodySnippet).toBeUndefined();
  });

  test('GET request → no requestBodySnippet', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/users', postDataBuffer: Buffer.from('{}') });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].requestBodySnippet).toBeUndefined();
  });

  test('POST to noise bucket (analytics) → no requestBodySnippet', async () => {
    const { ctx, action } = makeCapture();
    const req = makeRequest({ method: 'POST', url: 'https://analytics.example.com/collect', postDataBuffer: Buffer.from('{"event":"click"}') });
    await fireRequest(ctx, req, makeResponse());
    expect((action.networkEvents ?? [])[0].requestBodySnippet).toBeUndefined();
  });

  test('POST body > 500 chars → truncated with ...', async () => {
    const { ctx, action } = makeCapture();
    const longBody = JSON.stringify({ data: 'x'.repeat(600) });
    const req = makeRequest({ method: 'POST', url: 'http://localhost/api/data', postDataBuffer: Buffer.from(longBody) });
    await fireRequest(ctx, req, makeResponse());
    const snippet = (action.networkEvents ?? [])[0].requestBodySnippet!;
    expect(snippet).toHaveLength(503); // 500 chars + '...'
    expect(snippet.endsWith('...')).toBe(true);
  });

  test('POST body exactly 500 chars → no trailing ...', async () => {
    const { ctx, action } = makeCapture();
    const exactBody = 'a'.repeat(500);
    const req = makeRequest({ method: 'POST', url: 'http://localhost/api/data', postDataBuffer: Buffer.from(exactBody) });
    await fireRequest(ctx, req, makeResponse());
    const snippet = (action.networkEvents ?? [])[0].requestBodySnippet!;
    expect(snippet).toBe(exactBody);
    expect(snippet.endsWith('...')).toBe(false);
  });
});
