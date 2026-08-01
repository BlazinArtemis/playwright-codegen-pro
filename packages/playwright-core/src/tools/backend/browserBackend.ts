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

import path from 'path';

import { Context } from './context';
import { Response, parseResponse } from './response';
import { SessionLog } from './sessionLog';
import { McpSessionRecorder } from './mcpSessionRecorder';
import { debug } from '../../utilsBundle';

import type { ContextConfig } from './context';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type { McpRecorderState } from './mcpSessionRecorder';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

// The browser dying does not end the MCP session: the user can close the window, the
// browser can crash, or a CDP connection can drop. These are the errors that surface
// when a tool then talks to the dead browser.
const kBrowserGoneRe = /Target (?:page, context or browser has been closed|closed)|Browser (?:has been closed|has disconnected|closed unexpectedly)|(?:Page|Browser context) has been closed|Connection closed/i;

// Recordings that were in flight when a browser died, keyed by cwd. Handed to the
// replacement backend so a crash mid-flow does not restart the test from scratch.
const pendingRecordings = new Map<string, McpRecorderState>();

export class BrowserBackend implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _recorder: McpSessionRecorder | undefined;
  private _config: ContextConfig;
  private _cwd: string | undefined;
  private _browserGone = false;
  readonly browserContext: playwright.BrowserContext;

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[]) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._context = new Context(this.browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      cwd: clientInfo.cwd,
    });
    // Always-on live recording: every browser tool the agent fires is captured into
    // .playwright-session.md (read by recorder_get_session) and a runnable draft spec.
    const cwd = clientInfo.cwd || process.cwd();
    this._cwd = cwd;
    // Resume a recording that a dead browser interrupted, so the flow continues in the
    // same test rather than starting over from the relaunch.
    const resumeFrom = pendingRecordings.get(cwd);
    pendingRecordings.delete(cwd);
    this._recorder = new McpSessionRecorder(this.browserContext, {
      cwd,
      scenarioName: 'Recorded via Playwright Codegen Pro MCP',
      specFile: path.join(cwd, 'tests', 'mcp-session.spec.ts'),
      secrets: this._config.secrets,
      resumeFrom,
    });
    this._context.mcpRecorder = this._recorder;
  }

  async dispose() {
    if (this._browserGone && this._recorder && this._cwd)
      pendingRecordings.set(this._cwd, this._recorder.takeState());
    await this._recorder?.dispose().catch(e => debug('pw:tools:error')(e));
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `### Error\nTool "${name}" not found` }],
        isError: true,
      };
    }
    // eslint-disable-next-line no-restricted-syntax
    const parsedArguments = tool.schema.inputSchema.parse(rawArguments) as any;
    const cwd = rawArguments._meta?.cwd;
    const context = this._context!;
    const response = new Response(context, name, parsedArguments, cwd);
    context.setRunningTool(name);
    this._recorder?.beginAction(name);
    let responseObject: mcpServer.CallToolResult;
    try {
      await tool.handle(context, parsedArguments, response);
      responseObject = await response.serialize();
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
      this._recordAction(responseObject, cwd);
      this._maybeAnnounceRecording(name, responseObject);
    } catch (error: any) {
      this._recorder?.completeAction(undefined);
      if (await this._isBrowserGone(error)) {
        // isClose makes the server dispose this backend, so the next tool call builds a
        // fresh one (and a fresh browser) instead of failing forever with the same error.
        this._browserGone = true;
        return {
          content: [{ type: 'text' as const, text: `### Error\n${String(error)}\n\nThe browser is no longer running — it was closed or crashed outside of this session. It has been discarded and the next tool call will start a fresh browser, so retry your last action. The recording so far is preserved; you may need to re-navigate and sign in again.` }],
          isError: true,
          isClose: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `### Error\n${String(error)}` }],
        isError: true,
      };
    } finally {
      context.setRunningTool(undefined);
    }
    return responseObject;
  }

  // A target-closed error is only fatal to the session if the browser or its context is
  // actually gone — a page closing under an action (a popup, a self-closing window) throws
  // the same message while the browser is perfectly healthy, and must not tear it down.
  private async _isBrowserGone(error: any): Promise<boolean> {
    if (!kBrowserGoneRe.test(String(error?.message ?? error)))
      return false;
    const browser = this.browserContext.browser();
    if (!browser || !browser.isConnected())
      return true;
    // Browser still up: probe the context itself, which only throws once it is closed.
    return await this.browserContext.cookies().then(() => false, () => true);
  }

  // Prepend a one-shot recorder banner to the first browser_* result of a flow. Runs
  // AFTER _recordAction so the banner never leaks into the captured session artifacts.
  private _maybeAnnounceRecording(name: string, responseObject: mcpServer.CallToolResult): void {
    if (!name.startsWith('browser_'))
      return;
    const notice = this._recorder?.consumeStartNotice();
    if (!notice)
      return;
    responseObject.content = [{ type: 'text' as const, text: notice }, ...(responseObject.content ?? [])];
  }

  private _recordAction(responseObject: mcpServer.CallToolResult, cwd: string | undefined): void {
    if (!this._recorder)
      return;
    const parsed = parseResponse(responseObject, cwd);
    const pageUrl = parsed?.page?.match(/Page URL:\s*(\S+)/)?.[1];
    const pageTitle = parsed?.page?.match(/Page Title:\s*(.+)/)?.[1]?.trim();
    this._recorder.completeAction(parsed?.code, pageUrl, pageTitle);
  }
}
