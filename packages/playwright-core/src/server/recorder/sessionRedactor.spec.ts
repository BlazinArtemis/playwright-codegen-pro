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
import { redactSession } from './sessionRedactor';
import type { ActionInContext } from '@recorder/actions';

function makeAction(overrides: Partial<ActionInContext> = {}): ActionInContext {
  return {
    frame: { pageGuid: 'page1', pageAlias: 'page', framePath: [] },
    action: { name: 'click', selector: '#btn', signals: [], button: 'left', modifiers: 0, clickCount: 1 } as any,
    startTime: 0,
    ...overrides,
  };
}

function makeFill(selector: string, text: string): ActionInContext {
  return makeAction({
    action: { name: 'fill', selector, text, signals: [] } as any,
  });
}

test.describe('sessionRedactor', () => {
  test('immutability — deep copies input, never mutates', () => {
    const original = makeFill("input[name='password']", 'secret123');
    const originalText = 'secret123';
    redactSession([original], false);
    expect((original.action as any).text).toBe(originalText);
  });

  test('redacts password fill value by selector pattern', () => {
    const { actions, warnings } = redactSession([makeFill("input[name='password']", 'hunter2')], false);
    expect((actions[0].action as any).text).toContain('TEST_PASSWORD');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('password');
  });

  test('redacts passwd fill value', () => {
    const { actions } = redactSession([makeFill('#passwd', 'abc')], false);
    expect((actions[0].action as any).text).toContain('TEST_PASSWORD');
  });

  test('redacts token/api-key fill value by selector pattern', () => {
    const { actions, warnings } = redactSession([makeFill('#api_key', 'sk-12345')], false);
    expect((actions[0].action as any).text).toContain('TEST_API_KEY');
    expect(warnings[0]).toContain('API key');
  });

  test('redacts SSN/card fill value', () => {
    const { actions } = redactSession([makeFill('#ssn', '123-45-6789')], false);
    expect((actions[0].action as any).text).toBe("'[REDACTED]'");
  });

  test('does not redact unrelated fill values', () => {
    const { actions, warnings } = redactSession([makeFill('#username', 'alice')], false);
    expect((actions[0].action as any).text).toBe('alice');
    expect(warnings).toHaveLength(0);
  });

  test('redacts password in body snippet', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/login', method: 'POST', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        bodySnippet: '{"email":"a@b.com","password":"hunter2","remember":true}',
      }],
    });
    const { actions } = redactSession([action], false);
    expect(actions[0].networkEvents![0].bodySnippet).toContain('"password":"[redacted]"');
    expect(actions[0].networkEvents![0].bodySnippet).not.toContain('hunter2');
  });

  test('redacts Bearer token in body snippet', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/data', method: 'GET', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        bodySnippet: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig',
      }],
    });
    const { actions } = redactSession([action], false);
    expect(actions[0].networkEvents![0].bodySnippet).toContain('Bearer [redacted]');
  });

  test('redacts credit card number in body snippet', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/pay', method: 'POST', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        bodySnippet: '{"card":"4111 1111 1111 1111","cvv":"123"}',
      }],
    });
    const { actions } = redactSession([action], false);
    expect(actions[0].networkEvents![0].bodySnippet).toContain('[card-redacted]');
    expect(actions[0].networkEvents![0].bodySnippet).not.toContain('4111 1111');
  });

  test('detects data-creating actions (POST + direct + 201)', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/employees', method: 'POST', status: 201, bucket: 'direct',
        pageGuid: 'p1', firedMs: 0, isRedirect: false, aborted: false,
      }],
    });
    const { dataCreatingActions } = redactSession([action], false);
    expect(dataCreatingActions).toContain(0);
  });

  test('does NOT flag POST + direct + 200 as data-creating', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/employees', method: 'POST', status: 200, bucket: 'direct',
        pageGuid: 'p1', firedMs: 0, isRedirect: false, aborted: false,
      }],
    });
    const { dataCreatingActions } = redactSession([action], false);
    expect(dataCreatingActions).toHaveLength(0);
  });

  test('does NOT flag POST + pageLoad + 201 as data-creating', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/employees', method: 'POST', status: 201, bucket: 'pageLoad',
        pageGuid: 'p1', firedMs: 0, isRedirect: false, aborted: false,
      }],
    });
    const { dataCreatingActions } = redactSession([action], false);
    expect(dataCreatingActions).toHaveLength(0);
  });

  test('warnings count matches number of redactions', () => {
    const actions = [
      makeFill('#password', 'pw1'),
      makeFill('#api_key', 'key1'),
    ];
    const { warnings } = redactSession(actions, false);
    expect(warnings).toHaveLength(2);
  });

  test('hasWebSockets is passed through', () => {
    const { hasWebSockets } = redactSession([], true);
    expect(hasWebSockets).toBe(true);
  });

  test('graphQL operationName is preserved (not redacted)', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/graphql', method: 'POST', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        operationName: 'LoginUser',
        bodySnippet: '{"query":"mutation LoginUser {...}","variables":{"password":"pw"}}',
      }],
    });
    const { actions } = redactSession([action], false);
    expect(actions[0].networkEvents![0].operationName).toBe('LoginUser');
    expect(actions[0].networkEvents![0].bodySnippet).toContain('"password":"[redacted]"');
  });

  test('redacts password in requestBodySnippet', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/login', method: 'POST', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        requestBodySnippet: '{"email":"user@example.com","password":"hunter2"}',
      }],
    });
    const { actions, warnings } = redactSession([action], false);
    expect(actions[0].networkEvents![0].requestBodySnippet).toContain('"password":"[redacted]"');
    expect(actions[0].networkEvents![0].requestBodySnippet).toContain('"email":"user@example.com"');
    expect(warnings.some(w => w.includes('request payload'))).toBe(true);
  });

  test('redacts token in requestBodySnippet', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/refresh', method: 'POST', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        requestBodySnippet: '{"token":"eyJhbGciOiJSUzI1NiJ9.abc"}',
      }],
    });
    const { actions } = redactSession([action], false);
    expect(actions[0].networkEvents![0].requestBodySnippet).toContain('"token":"[redacted]"');
  });

  test('clean requestBodySnippet produces no warning', () => {
    const action = makeAction({
      networkEvents: [{
        url: '/api/employees', method: 'POST', bucket: 'direct', pageGuid: 'p1',
        firedMs: 0, isRedirect: false, aborted: false,
        requestBodySnippet: '{"name":"Alice Smith","role":"Engineer"}',
      }],
    });
    const { actions, warnings } = redactSession([action], false);
    expect(actions[0].networkEvents![0].requestBodySnippet).toBe('{"name":"Alice Smith","role":"Engineer"}');
    expect(warnings).toHaveLength(0);
  });
});
