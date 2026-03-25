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

import { Chat } from './chat';
import { redactSession } from './sessionRedactor';
import { buildPrompt } from './sessionPromptBuilder';

import type { ActionInContext } from '@recorder/actions';
import type { ExportOptions, ExportResult } from './sessionPromptBuilder';

export type { ExportOptions, ExportResult } from './sessionPromptBuilder';

export async function exportSession(
  actions: ActionInContext[],
  options: ExportOptions,
  _chatFactory?: (wsEndpoint: string) => { post<T>(prompt: string): Promise<T | null> }
): Promise<ExportResult> {
  const redactedSession = redactSession(actions, options.pageHasWebSockets);
  const prompt = buildPrompt(redactedSession, options);
  const wsEndpoint = options.wsEndpoint!;
  const chatInstance = _chatFactory ? _chatFactory(wsEndpoint) : new Chat(wsEndpoint);
  const code = await chatInstance.post<string>(prompt);
  if (!code)
    throw new Error('AI generation failed — check wsEndpoint configuration');
  return { code, warnings: redactedSession.warnings };
}
