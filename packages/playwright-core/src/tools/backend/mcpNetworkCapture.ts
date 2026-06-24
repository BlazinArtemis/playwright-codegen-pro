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

/**
 * Client-side network capture for the MCP recorder. Unlike the server-side
 * NetworkCapture used by `codegen` (which relies on time-window heuristics to
 * attribute requests to user actions), the MCP runs in discrete tool calls, so
 * each request is attributed to the action of the tool that was in flight when
 * it fired. Buckets:
 *   - noise:    static assets, analytics, polling, OPTIONS, token refresh
 *   - pageLoad: requests fired during a navigation tool
 *   - direct:   requests fired during any other action (clicks, fills, ...)
 */

import type * as playwright from '../../..';

export type McpNetworkBucket = 'direct' | 'pageLoad' | 'noise';

export type McpNetworkEvent = {
  url: string;
  method: string;
  bucket: McpNetworkBucket;
  status?: number;
  operationName?: string;
  requestBodySnippet?: string;
  bodySnippet?: string;
  aborted?: boolean;
};

/** The action that owns network events fired while its tool is running. */
export type CurrentActionRef = {
  toolName: string;
  startTime: number;
  events: McpNetworkEvent[];
};

const debugNet = !!process.env.PW_DEBUG_NETWORK;

export class McpNetworkCapture {
  private _context: playwright.BrowserContext;
  private _getCurrentAction: () => CurrentActionRef | null;
  private _onUpdate: () => void;
  private _pending = new Map<playwright.Request, McpNetworkEvent>();
  private _pollTracker = new Map<string, number[]>();
  private _listeners: Array<() => void> = [];

  constructor(context: playwright.BrowserContext, getCurrentAction: () => CurrentActionRef | null, onUpdate: () => void) {
    this._context = context;
    this._getCurrentAction = getCurrentAction;
    this._onUpdate = onUpdate;
  }

  start(): void {
    const onRequest = (req: playwright.Request) => this._onRequest(req);
    const onResponse = (res: playwright.Response) => void this._onResponse(res);
    const onFailed = (req: playwright.Request) => this._onFailed(req);
    this._context.on('request', onRequest);
    this._context.on('response', onResponse);
    this._context.on('requestfailed', onFailed);
    this._listeners.push(
        () => this._context.off('request', onRequest),
        () => this._context.off('response', onResponse),
        () => this._context.off('requestfailed', onFailed),
    );
  }

  dispose(): void {
    for (const remove of this._listeners)
      remove();
    this._listeners = [];
    this._pending.clear();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _isNoiseUrl(url: string, method: string): boolean {
    if (method === 'OPTIONS')
      return true;
    if (/\.(js|css|woff|woff2|ttf|eot|svg|png|jpg|jpeg|gif|ico|map)(\?|$)/i.test(url))
      return true;
    try {
      const parsed = new URL(url);
      if (/analytics|segment\.io|mixpanel|amplitude|hotjar|fullstory|heap\.io|intercom\.io|clarity\.ms|googletagmanager|google-analytics|facebook\.net|doubleclick|sentry\.io/.test(parsed.hostname))
        return true;
      if (/\/analytics\/|\/tracking\/|\/pixel|\/beacon|\/gen_204|\/log$|\/jserror/i.test(parsed.pathname))
        return true;
      // Common telemetry/instrumentation hosts and logging endpoints.
      if (/clients\d?\.google|play\.google\.com\/log|gstatic\.com|googleapis\.com\/.*\/log/i.test(url))
        return true;
    } catch {
      return true;
    }
    if (/refresh[_-]?token|token\/refresh|oauth\/token|auth\/refresh/i.test(url))
      return true;
    return false;
  }

  private _isPolling(key: string): boolean {
    const now = Date.now();
    const times = (this._pollTracker.get(key) ?? []).filter(t => now - t < 30_000);
    times.push(now);
    this._pollTracker.set(key, times);
    return times.length >= 3;
  }

  private _graphqlOperationName(request: playwright.Request): string | undefined {
    if (request.method() !== 'POST')
      return undefined;
    try {
      if (!/graphql/i.test(request.url()))
        return undefined;
      const buf = request.postDataBuffer();
      if (!buf)
        return undefined;
      const body = JSON.parse(buf.toString('utf-8'));
      return typeof body.operationName === 'string' ? body.operationName : undefined;
    } catch {
      return undefined;
    }
  }

  private _assignBucket(request: playwright.Request, action: CurrentActionRef | null, operationName: string | undefined): McpNetworkBucket {
    const url = request.url();
    const method = request.method();
    // Only real data calls (XHR/fetch) are signal; documents, scripts, styles,
    // images, fonts, pings/beacons are page machinery → noise.
    if (!['xhr', 'fetch'].includes(request.resourceType()))
      return 'noise';
    if (this._isNoiseUrl(url, method))
      return 'noise';
    if (!action)
      return 'noise';
    if (this._isPolling(`${operationName ?? url}|${method}`))
      return 'noise';
    return /navigate/i.test(action.toolName) ? 'pageLoad' : 'direct';
  }

  private _onRequest(request: playwright.Request): void {
    const action = this._getCurrentAction();
    const method = request.method();
    const operationName = this._graphqlOperationName(request);
    const bucket = this._assignBucket(request, action, operationName);

    let requestBodySnippet: string | undefined;
    if (bucket !== 'noise' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const buf = request.postDataBuffer();
      const text = buf?.toString('utf-8') ?? request.postData() ?? '';
      if (text)
        requestBodySnippet = text.slice(0, 500) + (text.length > 500 ? '...' : '');
    }

    const event: McpNetworkEvent = {
      url: request.url(),
      method,
      bucket,
      ...(operationName ? { operationName } : {}),
      ...(requestBodySnippet ? { requestBodySnippet } : {}),
    };
    this._pending.set(request, event);
    // Attach by reference so late responses update the same object the action holds.
    action?.events.push(event);

    if (debugNet)
      // eslint-disable-next-line no-console
      console.log(`[MCP-NC] ${method} ${event.url}${operationName ? ` (${operationName})` : ''} → ${bucket} (${action?.toolName ?? 'none'})`);
  }

  private async _onResponse(response: playwright.Response): Promise<void> {
    const request = response.request();
    const event = this._pending.get(request);
    if (!event)
      return;
    event.status = response.status();
    if (event.bucket !== 'noise') {
      const ct = response.headers()['content-type'] ?? '';
      if (/text|json|html/i.test(ct)) {
        const buf = await response.body().catch(() => null);
        if (buf)
          event.bodySnippet = buf.toString('utf-8').slice(0, 500);
      }
    }
    this._pending.delete(request);
    this._onUpdate();
  }

  private _onFailed(request: playwright.Request): void {
    const event = this._pending.get(request);
    if (!event)
      return;
    event.aborted = true;
    this._pending.delete(request);
    this._onUpdate();
  }
}
