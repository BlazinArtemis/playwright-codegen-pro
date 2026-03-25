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

import type { ActionInContext } from '@recorder/actions';

export interface RedactedSession {
  actions: ActionInContext[];     // deep copy with sensitive values replaced
  warnings: string[];            // one entry per redaction applied
  hasWebSockets: boolean;
  dataCreatingActions: number[]; // indices of actions (in collapsed array) with direct POST 201
}

export function redactSession(
  actions: ActionInContext[],
  pageHasWebSockets: boolean
): RedactedSession {
  const warnings: string[] = [];
  const dataCreatingActions: number[] = [];

  // Deep copy — never mutate the caller's objects
  const copy: ActionInContext[] = JSON.parse(JSON.stringify(actions));

  for (let i = 0; i < copy.length; i++) {
    const ctx = copy[i];
    const action = ctx.action;

    // ── Fill action: redact sensitive text values ─────────────────────────
    if (action.name === 'fill') {
      const fill = action as typeof action & { selector: string; text: string };
      const label = `${fill.selector} ${ctx.description ?? ''}`;
      if (/password|passwd|secret|credential|pin\b/i.test(label)) {
        warnings.push(`Redacted password fill value in step ${i + 1} (${fill.selector})`);
        fill.text = "process.env.TEST_PASSWORD || 'test-password'";
      } else if (/token|api.?key|api.?secret|auth.?key/i.test(label)) {
        warnings.push(`Redacted API key/token fill value in step ${i + 1} (${fill.selector})`);
        fill.text = "process.env.TEST_API_KEY || 'test-api-key'";
      } else if (/ssn|social.?security|card.?number|cvv/i.test(label)) {
        warnings.push(`Redacted sensitive PII fill value in step ${i + 1} (${fill.selector})`);
        fill.text = "'[REDACTED]'";
      }
    }

    // ── Network events: redact body snippets and strip sensitive headers ──
    for (const event of ctx.networkEvents ?? []) {
      if (event.requestBodySnippet) {
        const before = event.requestBodySnippet;
        event.requestBodySnippet = event.requestBodySnippet
            .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"[redacted]"')
            .replace(/"passwd"\s*:\s*"[^"]*"/g, '"passwd":"[redacted]"')
            .replace(/"token"\s*:\s*"[^"]*"/g, '"token":"[redacted]"')
            .replace(/"secret"\s*:\s*"[^"]*"/g, '"secret":"[redacted]"')
            .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
            .replace(/"Authorization"\s*:\s*"[^"]*"/g, '"Authorization":"[redacted]"')
            .replace(/\b[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}\b/g, '[card-redacted]');
        if (event.requestBodySnippet !== before)
          warnings.push(`Redacted sensitive data in ${event.method} ${event.url} request payload (step ${i + 1})`);
      }

      if (event.bodySnippet) {
        const before = event.bodySnippet;
        event.bodySnippet = event.bodySnippet
            .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"[redacted]"')
            .replace(/"passwd"\s*:\s*"[^"]*"/g, '"passwd":"[redacted]"')
            .replace(/"token"\s*:\s*"[^"]*"/g, '"token":"[redacted]"')
            .replace(/"secret"\s*:\s*"[^"]*"/g, '"secret":"[redacted]"')
            .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
            .replace(/"Authorization"\s*:\s*"[^"]*"/g, '"Authorization":"[redacted]"')
            .replace(/\b[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}\b/g, '[card-redacted]');
        if (event.bodySnippet !== before)
          warnings.push(`Redacted sensitive data in ${event.method} ${event.url} body (step ${i + 1})`);
      }

      // Data-creating action detection: direct POST with 201
      if (event.bucket === 'direct' && event.method === 'POST' && event.status === 201) {
        if (!dataCreatingActions.includes(i))
          dataCreatingActions.push(i);
      }
    }
  }

  return {
    actions: copy,
    warnings,
    hasWebSockets: pageHasWebSockets,
    dataCreatingActions,
  };
}
