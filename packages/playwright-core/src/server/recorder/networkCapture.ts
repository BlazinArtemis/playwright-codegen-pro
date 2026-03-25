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

import type { Request as NetworkRequest, Response as NetworkResponse } from '../network';
import type { ActionInContext, NetworkEvent } from '@recorder/actions';

// Inlined subset of recorderUtils.collapseActions/shouldMergeAction — avoids importing
// recorderUtils.ts which pulls utils.ts → utilsBundle → compiled bundle (breaks unit tests).
function _isSameAction(a: ActionInContext, b: ActionInContext): boolean {
  return a.action.name === b.action.name && a.frame.pageAlias === b.frame.pageAlias && a.frame.framePath.join('|') === b.frame.framePath.join('|');
}
function _shouldMergeAction(action: ActionInContext, lastAction: ActionInContext | undefined): boolean {
  if (!lastAction)
    return false;
  if (action.action.name === 'fill')
    return _isSameAction(action, lastAction) && 'selector' in action.action && 'selector' in lastAction.action && (action.action as any).selector === (lastAction.action as any).selector;
  if (action.action.name === 'navigate')
    return _isSameAction(action, lastAction);
  if (action.action.name === 'click')
    return _isSameAction(action, lastAction) && 'selector' in action.action && 'selector' in lastAction.action && (action.action as any).selector === (lastAction.action as any).selector && action.startTime - lastAction.startTime < 500 && (action.action as any).clickCount > (lastAction.action as any).clickCount;
  return false;
}
function _collapseActions(actions: ActionInContext[]): ActionInContext[] {
  const result: ActionInContext[] = [];
  for (const action of actions) {
    const last = result[result.length - 1];
    if (!_shouldMergeAction(action, last)) {
      result.push(action);
    } else {
      const startTime = last.startTime;
      result[result.length - 1] = action;
      result[result.length - 1].startTime = startTime;
    }
  }
  return result;
}

/**
 * Minimal interface that BrowserContext satisfies (via EventEmitter).
 * Keeping this as a local interface avoids importing BrowserContext, which
 * drags in the entire server bundle chain and breaks unit-test imports.
 */
export interface NetworkCaptureContext {
  on(event: string, listener: (...args: any[]) => void): any;
  off(event: string, listener: (...args: any[]) => void): any;
}

// String values matching BrowserContext.Events.* — defined locally to avoid
// importing BrowserContext (which would pull in the compiled utils bundle).
const CTX_EVENTS = {
  Request: 'request' as const,
  RequestFinished: 'requestfinished' as const,
  RequestFailed: 'requestfailed' as const,
  RequestAborted: 'requestaborted' as const,
};

const debugNetwork = !!process.env.PW_DEBUG_NETWORK;

export interface NetworkCaptureDelegate {
  onNetworkEventsUpdated(): void;
}

export class NetworkCapture {
  private _context: NetworkCaptureContext;
  private _delegate: NetworkCaptureDelegate;
  private _knownActions: ActionInContext[] = [];
  private _pending = new Map<string, { networkEvent: NetworkEvent; targetAction: ActionInContext | null }>();
  // pageGuid → timestamp of last nav signal
  private _navBoundaries = new Map<string, number>();
  // pageGuid → { until: absolute ms, fromClick: bool }
  private _bucketBWindows = new Map<string, { until: number; fromClick: boolean }>();
  // pageGuid+url+method → recent fire timestamps (for poll detection)
  private _pollTracker = new Map<string, number[]>();
  private _listeners: Array<() => void> = [];

  constructor(context: NetworkCaptureContext, delegate: NetworkCaptureDelegate) {
    this._context = context;
    this._delegate = delegate;
  }

  start(): void {
    const onRequest = (req: NetworkRequest) => this._onRequest(req);
    const onFinished = ({ request, response }: { request: NetworkRequest; response: NetworkResponse | null }) =>
      void this._onRequestFinished(request, response);
    const onFailed = (req: NetworkRequest) => this._onRequestAbortedOrFailed(req);
    const onAborted = (req: NetworkRequest) => this._onRequestAbortedOrFailed(req);

    this._context.on(CTX_EVENTS.Request, onRequest);
    this._context.on(CTX_EVENTS.RequestFinished, onFinished);
    this._context.on(CTX_EVENTS.RequestFailed, onFailed);
    this._context.on(CTX_EVENTS.RequestAborted, onAborted);

    this._listeners.push(
        () => this._context.off(CTX_EVENTS.Request, onRequest),
        () => this._context.off(CTX_EVENTS.RequestFinished, onFinished),
        () => this._context.off(CTX_EVENTS.RequestFailed, onFailed),
        () => this._context.off(CTX_EVENTS.RequestAborted, onAborted),
    );
  }

  stop(): void {
    this.dispose();
  }

  dispose(): void {
    for (const remove of this._listeners)
      remove();
    this._listeners = [];
  }

  onActionAdded(action: ActionInContext): void {
    this._knownActions.push(action);
    if (debugNetwork)
      console.log(`[NC] action "${action.action.name}" at t=${action.startTime}`);
  }

  onNavigationSignal(pageGuid: string, url: string): void {
    const now = Date.now();
    this._navBoundaries.set(pageGuid, now);
    // Determine window length: 1500ms if the last action on this page was a click, else 800ms
    const lastAction = this._findLastActionForPage(pageGuid);
    const fromClick = lastAction?.action.name === 'click';
    const windowMs = fromClick ? 1500 : 800;
    this._bucketBWindows.set(pageGuid, { until: now + windowMs, fromClick });
    if (debugNetwork)
      console.log(`[NC] nav signal pageGuid=${pageGuid} url=${url} → Bucket B window=${windowMs}ms`);
  }

  async waitForPendingResponses(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (this._pending.size > 0 && Date.now() < deadline)
      await new Promise(r => setTimeout(r, 50));
  }

  getEnrichedActions(rawActions: ActionInContext[]): ActionInContext[] {
    // _collapseActions returns original object references with events already mutated onto them
    return _collapseActions(rawActions);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _findLastActionForPage(pageGuid: string): ActionInContext | null {
    for (let i = this._knownActions.length - 1; i >= 0; i--) {
      if (this._knownActions[i].frame.pageGuid === pageGuid)
        return this._knownActions[i];
    }
    return null;
  }

  private _isNoiseUrl(url: string, method: string): boolean {
    if (method === 'OPTIONS')
      return true;
    // Static assets
    if (/\.(js|css|woff|woff2|ttf|eot|svg|png|jpg|jpeg|gif|ico|map)(\?|$)/i.test(url))
      return true;
    // Analytics / tracking — check both hostname and path
    try {
      const parsed = new URL(url);
      if (/analytics|segment\.io|mixpanel|amplitude|hotjar|fullstory|heap\.io|intercom\.io|clarity\.ms|googletagmanager|google-analytics|facebook\.net/.test(parsed.hostname))
        return true;
      // Catch analytics paths on same-origin (e.g. /analytics/pixel)
      if (/\/analytics\/|\/tracking\/|\/pixel|\/beacon/i.test(parsed.pathname))
        return true;
    } catch {
      // malformed URL — treat as noise
      return true;
    }
    // Token refresh endpoints
    if (/refresh[_-]?token|token\/refresh|oauth\/token|auth\/refresh/i.test(url))
      return true;
    return false;
  }

  private _isPolling(pageGuid: string, key: string, method: string): boolean {
    const trackKey = `${pageGuid}|${key}|${method}`;
    const now = Date.now();
    const times = (this._pollTracker.get(trackKey) ?? []).filter(t => now - t < 30_000);
    times.push(now);
    this._pollTracker.set(trackKey, times);
    return times.length >= 3;
  }

  private _extractGraphQLOperationName(request: NetworkRequest): string | undefined {
    if (request.method() !== 'POST')
      return undefined;
    try {
      const url = request.url();
      if (!/graphql/i.test(url))
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

  private _assignBucket(request: NetworkRequest, pageGuid: string): NetworkEvent['bucket'] {
    const now = Date.now();
    const method = request.method();
    const url = request.url();

    // Pre-filter → noise
    if (this._isNoiseUrl(url, method))
      return 'noise';

    // No page → cross-tab / service worker → noise
    if (!pageGuid)
      return 'noise';

    // Check if pageGuid belongs to any known action
    const knownPage = this._knownActions.some(a => a.frame.pageGuid === pageGuid);
    if (!knownPage)
      return 'noise';

    // GraphQL operationName for poll detection key
    const opName = this._extractGraphQLOperationName(request);
    const pollKey = opName ?? url;
    if (this._isPolling(pageGuid, pollKey, method))
      return 'noise';

    // Bucket B: page-load window active?
    const bWindow = this._bucketBWindows.get(pageGuid);
    if (bWindow && now <= bWindow.until)
      return 'pageLoad';

    // Bucket A: after an action, before the next nav signal
    const navTime = this._navBoundaries.get(pageGuid) ?? 0;
    const lastAction = this._findLastActionForPage(pageGuid);
    if (lastAction && lastAction.startTime > navTime)
      return 'direct';

    return 'noise';
  }

  private _onRequest(request: NetworkRequest): void {
    // Frame._page is a public property (Playwright naming convention — no TypeScript `private` keyword)
    const pageGuid: string = (request.frame() as any)?._page?.guid ?? '';
    const method = request.method();
    const url = request.url();

    // Redirect chain: inherit bucket from redirected-from if already tracked
    const redirectedFrom = request.redirectedFrom();
    if (redirectedFrom) {
      const parentEntry = this._pending.get(redirectedFrom.guid);
      if (parentEntry) {
        const networkEvent: NetworkEvent = {
          ...parentEntry.networkEvent,
          isRedirect: true,
          firedMs: Date.now() - (parentEntry.targetAction?.startTime ?? 0),
          aborted: false,
          status: undefined,
          resolvedMs: undefined,
          requestBodySnippet: undefined,
          bodySnippet: undefined,
        };
        this._pending.set(request.guid, { networkEvent, targetAction: parentEntry.targetAction });
        return;
      }
    }

    const bucket = this._assignBucket(request, pageGuid);
    // Attach event to the last known action for this page, even for noise events,
    // so the NetworkPanel can display them (grayed out). Only skip when there is
    // no known page (empty pageGuid or unknown page — those are already 'noise').
    const targetAction = pageGuid ? this._findLastActionForPage(pageGuid) : null;

    const operationName = this._extractGraphQLOperationName(request);

    let requestBodySnippet: string | undefined;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && bucket !== 'noise') {
      const buf = request.postDataBuffer();
      if (buf) {
        const text = buf.toString('utf-8');
        if (text)
          requestBodySnippet = text.slice(0, 500) + (text.length > 500 ? '...' : '');
      }
    }

    const networkEvent: NetworkEvent = {
      url,
      method,
      bucket,
      pageGuid,
      firedMs: Date.now() - (targetAction?.startTime ?? 0),
      isRedirect: !!request.redirectedFrom(),
      aborted: false,
      ...(operationName ? { operationName } : {}),
      ...(requestBodySnippet ? { requestBodySnippet } : {}),
    };

    this._pending.set(request.guid, { networkEvent, targetAction });

    if (debugNetwork) {
      const actionLabel = targetAction ? `"${targetAction.action.name}"` : 'none';
      console.log(`[NC]   ${method} ${url}${operationName ? ` (${operationName})` : ''} → Bucket ${bucket} linked=${actionLabel}`);
    }
  }

  private async _onRequestFinished(request: NetworkRequest, response: NetworkResponse | null): Promise<void> {
    const entry = this._pending.get(request.guid);
    if (!entry)
      return;

    if (response) {
      entry.networkEvent.status = response.status();
      entry.networkEvent.resolvedMs = Date.now() - (entry.targetAction?.startTime ?? 0);

      // response.headers() returns HeadersArray = Array<{name: string, value: string}>
      const ct = response.headers().find((h: { name: string; value: string }) => h.name.toLowerCase() === 'content-type')?.value ?? '';
      if (/text|json|html/i.test(ct)) {
        // .catch() handles 3xx redirect body throw and any other error
        const buf = await response.body().catch(() => null);
        if (buf)
          entry.networkEvent.bodySnippet = buf.toString('utf-8').slice(0, 500);
      }
    }

    this._pending.delete(request.guid);

    if (entry.targetAction) {
      entry.targetAction.networkEvents ??= [];
      entry.targetAction.networkEvents.push(entry.networkEvent);
    }

    this._delegate.onNetworkEventsUpdated();
  }

  private _onRequestAbortedOrFailed(request: NetworkRequest): void {
    const entry = this._pending.get(request.guid);
    if (!entry)
      return;

    entry.networkEvent.aborted = true;
    this._pending.delete(request.guid);

    if (entry.targetAction) {
      entry.targetAction.networkEvents ??= [];
      entry.targetAction.networkEvents.push(entry.networkEvent);
    }

    this._delegate.onNetworkEventsUpdated();
  }
}
