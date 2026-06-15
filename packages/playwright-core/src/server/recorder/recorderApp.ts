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

import fs from 'fs';
import path from 'path';

import { isUnderTest } from '../utils/debug';
import { mime } from '../../utilsBundle';
import { syncLocalStorageWithSettings } from '../launchApp';
import { launchApp } from '../launchApp';
import { ProgressController } from '../progress';
import { ThrottledFile } from './throttledFile';
import { languageSet } from '../codegen/languages';
import { collapseActions, shouldMergeAction } from './recorderUtils';
import { generateCode } from '../codegen/language';
import { Recorder, RecorderEvent } from '../recorder';
import { BrowserContext } from '../browserContext';
import { NetworkCapture } from './networkCapture';
import { exportSession } from './sessionExporter';
import { Chat } from './chat';
import { redactSession } from './sessionRedactor';
import { buildPrompt } from './sessionPromptBuilder';

import type { Page } from '../page';
import type * as actions from '@recorder/actions';
import type { CallLog, ElementInfo, GenerationStatusEvent, Mode, NetworkPanelEntry, RecorderBackend, RecorderFrontend, Source } from '@recorder/recorderTypes';
import type { Language, LanguageGeneratorOptions } from '../codegen/types';
import type * as channels from '@protocol/channels';
import type { Progress } from '../progress';
import type { AriaTemplateNode } from '@isomorphic/ariaSnapshot';

export type RecorderAppParams = channels.BrowserContextEnableRecorderParams & {
  browserName: string;
  sdkLanguage: Language;
  headed: boolean;
  executablePath?: string;
  channel?: string;
};

export class RecorderApp {
  private _recorder: Recorder;
  private _page: Page;
  readonly wsEndpointForTest: string | undefined;
  private _languageGeneratorOptions: LanguageGeneratorOptions;
  private _throttledOutputFile: ThrottledFile | null = null;
  private _actions: actions.ActionInContext[] = [];
  private _userSources: Source[] = [];
  private _recorderSources: Source[] = [];
  private _primaryGeneratorId: string;
  private _selectedGeneratorId: string;
  private _frontend: RecorderFrontend;
  private _aiCodegen: boolean;
  private _networkCapture: NetworkCapture | null = null;
  private _inspectedContext: BrowserContext | null = null;
  private _scenarioName: string = 'my scenario';
  private _throttledSessionFile: ThrottledFile | null = null;
  private _screenshotDir: string | null = null;
  private _actionScreenshots: Map<actions.ActionInContext, string> = new Map();
  private _screenshotCounter: number = 0;

  private constructor(recorder: Recorder, params: RecorderAppParams, page: Page, wsEndpointForTest: string | undefined) {
    this._page = page;
    this._recorder = recorder;
    this._frontend = createRecorderFrontend(page);
    this.wsEndpointForTest = process.env.PW_AI_ENDPOINT || wsEndpointForTest;

    // Make a copy of options to modify them later.
    this._languageGeneratorOptions = {
      browserName: params.browserName,
      launchOptions: { headless: false, ...params.launchOptions, tracesDir: undefined },
      contextOptions: { ...params.contextOptions },
      deviceName: params.device,
      saveStorage: params.saveStorage,
    };

    this._aiCodegen = !!params.aiCodegen;
    this._throttledOutputFile = params.outputFile ? new ThrottledFile(params.outputFile) : null;
    if (this._aiCodegen) {
      this._throttledSessionFile = new ThrottledFile(path.join(process.cwd(), '.playwright-session.md'));
      this._screenshotDir = path.join(process.cwd(), '.playwright-session-screenshots');
      try {
        fs.rmSync(this._screenshotDir, { recursive: true, force: true });
      } catch {}
      try {
        fs.mkdirSync(this._screenshotDir, { recursive: true });
      } catch {}
    }
    this._primaryGeneratorId = process.env.TEST_INSPECTOR_LANGUAGE || params.language || determinePrimaryGeneratorId(params.sdkLanguage);
    this._selectedGeneratorId = this._primaryGeneratorId;
    for (const languageGenerator of languageSet()) {
      if (languageGenerator.id === this._primaryGeneratorId)
        this._recorder.setLanguage(languageGenerator.highlighter);
    }
  }

  private async _init(inspectedContext: BrowserContext) {
    this._inspectedContext = inspectedContext;
    await syncLocalStorageWithSettings(this._page, 'recorder');

    const controller = new ProgressController();
    await controller.run(async progress => {
      await this._page.addRequestInterceptor(progress, route => {
        if (!route.request().url().startsWith('https://playwright/')) {
          route.continue({ isFallback: true }).catch(() => {});
          return;
        }

        const uri = route.request().url().substring('https://playwright/'.length);
        const file = require.resolve('../../vite/recorder/' + uri);
        fs.promises.readFile(file).then(buffer => {
          route.fulfill({
            status: 200,
            headers: [
              { name: 'Content-Type', value: mime.getType(path.extname(file)) || 'application/octet-stream' }
            ],
            body: buffer.toString('base64'),
            isBase64: true
          }).catch(() => {});
        });
      });

      await this._createDispatcher(progress);

      this._page.once('close', () => {
        this._throttledSessionFile?.flush();
        this._networkCapture?.dispose();
        this._networkCapture = null;
        this._recorder.close();
        void this._finalizeVideo();
        // Close inspected context first so the CLI's page-close handler can call closeBrowser()
        inspectedContext.close({ reason: 'Recorder window closed' }).catch(() => {});
        this._page.browserContext.close({ reason: 'Recorder window closed' }).catch(() => {});
        delete (inspectedContext as any)[recorderAppSymbol];
      });

      await this._page.mainFrame().goto(progress, 'https://playwright/index.html');
    });

    const url = this._recorder.url();
    if (url)
      this._frontend.pageNavigated({ url });
    this._frontend.modeChanged({ mode: this._recorder.mode() });
    this._frontend.configUpdated({ aiCodegen: this._aiCodegen });
    this._frontend.pauseStateChanged({ paused: this._recorder.paused() });
    this._updateActions('reveal');
    // Update paused sources *after* generated ones, to reveal the currently paused source if any.
    this._onUserSourcesChanged(this._recorder.userSources(), this._recorder.pausedSourceId());
    this._frontend.callLogsUpdated({ callLogs: this._recorder.callLog() });
    this._wireListeners(this._recorder);

    // If the recorder is already in 'recording' mode at init time, the ModeChanged
    // event above fired before _wireListeners attached — start NetworkCapture now.
    if (this._aiCodegen && this._recorder.mode() === 'recording' && !this._networkCapture && this._inspectedContext) {
      this._networkCapture = new NetworkCapture(this._inspectedContext, {
        onNetworkEventsUpdated: () => this._updateNetworkPanel(),
      });
      this._networkCapture.start();
    }
  }

  private async _createDispatcher(progress: Progress) {
    const dispatcher: Partial<RecorderBackend> & Omit<RecorderBackend, 'generateTest' | 'setScenarioName'> = {
      clear: async () => {
        this._actions = [];
        this._updateActions('reveal');
        this._recorder.clear();
      },
      fileChanged: async (params: { fileId: string }) => {
        const source = [...this._recorderSources, ...this._userSources].find(s => s.id === params.fileId);
        if (source) {
          if (source.isRecorded)
            this._selectedGeneratorId = source.id;
          await this._recorder.setLanguage(source.language);
        }
      },
      setAutoExpect: async (params: { autoExpect: boolean }) => {
        this._languageGeneratorOptions.generateAutoExpect = params.autoExpect;
        this._updateActions();
      },
      setMode: async (params: { mode: Mode }) => {
        await this._recorder.setMode(params.mode);
      },
      resume: async () => {
        this._recorder.resume();
      },
      pause: async () => {
        this._recorder.pause();
      },
      step: async () => {
        this._recorder.step();
      },
      highlightRequested: async (params: { selector?: string; ariaTemplate?: AriaTemplateNode }) => {
        if (params.selector)
          await this._recorder.setHighlightedSelector(params.selector);
        if (params.ariaTemplate)
          await this._recorder.setHighlightedAriaTemplate(params.ariaTemplate);
      },
      ...(this._aiCodegen ? {
        generateTest: async (params: { scenarioName: string; outputFile: string }) => {
          void this._runGeneration(params.scenarioName, params.outputFile);
        },
        setScenarioName: async (params: { name: string }) => {
          this._scenarioName = params.name;
        },
      } : {}),
    };

    await this._page.exposeBinding(progress, 'sendCommand', false, async (_, data: any) => {
      const { method, params } = data as { method: string; params: any };
      return await (dispatcher as any)[method].call(dispatcher, params);
    });
  }

  static async show(context: BrowserContext, params: channels.BrowserContextEnableRecorderParams) {
    if (process.env.PW_CODEGEN_NO_INSPECTOR)
      return;
    const recorder = await Recorder.forContext(context, params);
    if (params.recorderMode === 'api') {
      const browserName = context._browser.options.name;
      await ProgrammaticRecorderApp.run(context, recorder, browserName, params);
      return;
    }
    await RecorderApp._show(recorder, context, params);
  }

  async close() {
    this._networkCapture?.dispose();
    this._networkCapture = null;
    await this._page.close();
  }

  static showInspectorNoReply(context: BrowserContext) {
    if (process.env.PW_CODEGEN_NO_INSPECTOR)
      return;
    void Recorder.forContext(context, {}).then(recorder => RecorderApp._show(recorder, context, {})).catch(() => {});
  }

  private static async _show(recorder: Recorder, inspectedContext: BrowserContext, params: channels.BrowserContextEnableRecorderParams) {
    if ((inspectedContext as any)[recorderAppSymbol])
      return;
    (inspectedContext as any)[recorderAppSymbol] = true;
    const sdkLanguage = inspectedContext._browser.sdkLanguage();
    const isChromium = inspectedContext._browser.options.browserType === 'chromium';
    const headed = !!inspectedContext._browser.options.headful;
    const recorderPlaywright = (require('../playwright').createPlaywright as typeof import('../playwright').createPlaywright)({ sdkLanguage: 'javascript', isInternalPlaywright: true });
    const { context: appContext, page } = await launchApp(recorderPlaywright.chromium, {
      sdkLanguage,
      windowSize: { width: 600, height: 600 },
      windowPosition: { x: 1020, y: 10 },
      persistentContextOptions: {
        noDefaultViewport: true,
        headless: !!process.env.PWTEST_CLI_HEADLESS || (isUnderTest() && !headed),
        cdpPort: isUnderTest() ? 0 : undefined,
        handleSIGINT: params.handleSIGINT,
        executablePath: isChromium ? inspectedContext._browser.options.customExecutablePath : undefined,
        // Use the same channel as the inspected context to guarantee that the browser is installed.
        channel: isChromium ? inspectedContext._browser.options.channel : undefined,
      }
    });
    const controller = new ProgressController();
    await controller.run(async progress => {
      await appContext._browser._defaultContext!._loadDefaultContextAsIs(progress);
    });

    const appParams = {
      browserName: inspectedContext._browser.options.name,
      sdkLanguage: inspectedContext._browser.sdkLanguage(),
      wsEndpointForTest: inspectedContext._browser.options.wsEndpoint,
      headed: !!inspectedContext._browser.options.headful,
      executablePath: isChromium ? inspectedContext._browser.options.customExecutablePath : undefined,
      channel: isChromium ? inspectedContext._browser.options.channel : undefined,
      ...params,
    };

    const recorderApp = new RecorderApp(recorder, appParams, page, appContext._browser.options.wsEndpoint);
    await recorderApp._init(inspectedContext);
    (inspectedContext as any).recorderAppForTest = recorderApp;
  }

  private _wireListeners(recorder: Recorder) {
    recorder.on(RecorderEvent.ActionAdded, (action: actions.ActionInContext) => {
      this._onActionAdded(action);
    });

    recorder.on(RecorderEvent.SignalAdded, (signal: actions.SignalInContext) => {
      this._onSignalAdded(signal);
    });

    recorder.on(RecorderEvent.PageNavigated, (url: string) => {
      this._frontend.pageNavigated({ url });
    });

    recorder.on(RecorderEvent.ContextClosed, () => {
      this._throttledOutputFile?.flush();
      this._throttledSessionFile?.flush();
      this._networkCapture?.dispose();
      this._networkCapture = null;
      void this._finalizeVideo();
      this._page.browserContext.close({ reason: 'Recorder window closed' }).catch(() => {});
    });

    recorder.on(RecorderEvent.ModeChanged, (mode: Mode) => {
      this._frontend.modeChanged({ mode });
      if (this._aiCodegen && mode === 'recording' && !this._networkCapture && this._inspectedContext) {
        this._networkCapture = new NetworkCapture(this._inspectedContext, {
          onNetworkEventsUpdated: () => this._updateNetworkPanel(),
        });
        this._networkCapture.start();
      }
      if (mode !== 'recording' && this._networkCapture) {
        this._networkCapture.stop();
        this._networkCapture = null;
      }
    });

    recorder.on(RecorderEvent.PausedStateChanged, (paused: boolean) => {
      this._frontend.pauseStateChanged({ paused });
    });

    recorder.on(RecorderEvent.UserSourcesChanged, (sources: Source[], pausedSourceId?: string) => {
      this._onUserSourcesChanged(sources, pausedSourceId);
    });

    recorder.on(RecorderEvent.ElementPicked, (elementInfo: ElementInfo, userGesture?: boolean) => {
      if (userGesture)
        this._page.bringToFront();
      this._frontend.elementPicked({ elementInfo, userGesture });
    });

    recorder.on(RecorderEvent.CallLogsUpdated, (callLogs: CallLog[]) => {
      this._frontend.callLogsUpdated({ callLogs });
    });
  }

  private _onActionAdded(action: actions.ActionInContext) {
    this._actions.push(action);
    this._networkCapture?.onActionAdded(action);
    this._updateActions('reveal');
    void this._captureScreenshotForAction(action);
  }

  private async _captureScreenshotForAction(action: actions.ActionInContext) {
    if (!this._screenshotDir || !this._inspectedContext)
      return;
    const page = findPageByGuid(this._inspectedContext, action.frame.pageGuid);
    if (!page)
      return;
    const index = ++this._screenshotCounter;
    const filename = `${String(index).padStart(3, '0')}-${action.action.name}.png`;
    const filepath = path.join(this._screenshotDir, filename);
    try {
      const controller = new ProgressController();
      await controller.run(async progress => {
        const buffer = await page.screenshot(progress, { type: 'png', fullPage: false });
        await fs.promises.writeFile(filepath, buffer);
      });
      this._actionScreenshots.set(action, filepath);
      this._updateActions();
    } catch {
      // Page may have closed or screenshot failed — non-fatal
    }
  }

  private _onSignalAdded(signal: actions.SignalInContext) {
    const lastAction = this._actions.findLast(a => a.frame.pageGuid === signal.frame.pageGuid);
    if (lastAction)
      lastAction.action.signals.push(signal.signal);
    this._updateActions();
    if (signal.signal.name === 'navigation') {
      this._networkCapture?.onNavigationSignal(
          signal.frame.pageGuid,
          (signal.signal as actions.NavigationSignal).url
      );
    }
  }

  private _onUserSourcesChanged(sources: Source[], pausedSourceId: string | undefined) {
    if (!sources.length && !this._userSources.length)
      return;
    this._userSources = sources;
    this._pushAllSources();
    this._revealSource(pausedSourceId);
  }

  private _pushAllSources() {
    const sources = [...this._userSources, ...this._recorderSources];
    this._frontend.sourcesUpdated({ sources });
  }

  private _revealSource(sourceId: string | undefined) {
    if (!sourceId)
      return;
    this._frontend.sourceRevealRequested({ sourceId });
  }

  private _updateActions(reveal?: 'reveal') {
    const recorderSources = [];
    const actions = collapseActions(this._actions);

    let revealSourceId: string | undefined;
    for (const languageGenerator of languageSet()) {
      const { header, footer, actionTexts, text } = generateCode(actions, languageGenerator, this._languageGeneratorOptions);
      const source: Source = {
        isRecorded: true,
        label: languageGenerator.name,
        group: languageGenerator.groupName,
        id: languageGenerator.id,
        text,
        header,
        footer,
        actions: actionTexts,
        language: languageGenerator.highlighter,
        highlight: []
      };
      source.revealLine = text.split('\n').length - 1;
      recorderSources.push(source);
      if (languageGenerator.id === this._primaryGeneratorId)
        this._throttledOutputFile?.setContent(source.text);
      if (reveal === 'reveal' && source.id === this._selectedGeneratorId)
        revealSourceId = source.id;
    }

    this._recorderSources = recorderSources;
    this._pushAllSources();
    this._revealSource(revealSourceId);

    if (this._throttledSessionFile) {
      const enriched = this._networkCapture
        ? this._networkCapture.getEnrichedActions(this._actions)
        : actions;
      const redacted = redactSession(enriched, false);
      const prompt = buildPrompt(redacted, {
        scenarioName: this._scenarioName,
        outputFile: 'tests/' + this._scenarioName.replace(/\s+/g, '-') + '.spec.ts',
        mode: 'clipboard',
        pageHasWebSockets: false,
        screenshots: this._actionScreenshots,
        videoPath: this._aiCodegen ? '.playwright-session.webm' : undefined,
      });
      this._throttledSessionFile.setContent(prompt);
    }
  }

  private _updateNetworkPanel() {
    const entries: NetworkPanelEntry[] = [];
    // Use collapseActions so linkedStepIndex aligns with source.actions indices
    const collapsed = collapseActions(this._actions);
    for (let i = 0; i < collapsed.length; i++) {
      for (const event of collapsed[i].networkEvents ?? []) {
        entries.push({
          url: event.url,
          method: event.method,
          status: event.status,
          bucket: event.bucket,
          linkedStepIndex: i,
          operationName: event.operationName,
        });
      }
    }
    this._frontend.networkEntriesUpdated({ entries });
  }

  private _emitGenerationStatus(params: GenerationStatusEvent) {
    this._frontend.generationStatusChanged(params);
  }

  private async _exportPrompt(scenarioName: string, outputFile: string): Promise<void> {
    try {
      this._emitGenerationStatus({ status: 'analyzing', message: 'Building prompt...', progress: 30 });
      await this._networkCapture?.waitForPendingResponses(15000);

      const enrichedActions = this._networkCapture
        ? this._networkCapture.getEnrichedActions(this._actions)
        : collapseActions(this._actions);

      const redactedSession = redactSession(enrichedActions, false);
      const prompt = buildPrompt(redactedSession, {
        scenarioName,
        outputFile,
        mode: 'clipboard',
        pageHasWebSockets: false,
        screenshots: this._actionScreenshots,
        videoPath: this._aiCodegen ? '.playwright-session.webm' : undefined,
      });

      const promptFilePath = path.join(process.cwd(), '.playwright-prompt.md');
      await fs.promises.writeFile(promptFilePath, prompt, 'utf-8');

      this._frontend.promptReady({ prompt, filePath: promptFilePath });

      this._emitGenerationStatus({
        status: 'exported',
        message: 'Prompt copied to clipboard and saved to .playwright-prompt.md',
        progress: 100,
        promptFilePath,
      });
    } catch (error: any) {
      this._emitGenerationStatus({ status: 'error', message: String(error?.message ?? error), progress: 0 });
    }
  }

  private async _finalizeVideo(): Promise<void> {
    if (!this._aiCodegen)
      return;
    const videoDir = path.join(process.cwd(), '.playwright-session-video');
    const finalPath = path.join(process.cwd(), '.playwright-session.webm');
    // Wait briefly for video file to flush after context close
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const files = await fs.promises.readdir(videoDir);
        const webmFile = files.find(f => f.endsWith('.webm'));
        if (webmFile) {
          await fs.promises.rename(path.join(videoDir, webmFile), finalPath);
          await fs.promises.rm(videoDir, { recursive: true, force: true }).catch(() => {});
          return;
        }
      } catch {
        // Directory might not exist yet
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private async _runGeneration(scenarioName: string, outputFile: string): Promise<void> {
    if (!process.env.PW_AI_ENDPOINT) {
      await this._exportPrompt(scenarioName, outputFile);
      return;
    }

    try {
      this._emitGenerationStatus({ status: 'finalizing', message: 'Waiting for pending API responses...', progress: 10 });
      await this._networkCapture?.waitForPendingResponses(15000);

      this._emitGenerationStatus({ status: 'analyzing', message: 'Analyzing session...', progress: 30 });
      const enrichedActions = this._networkCapture
        ? this._networkCapture.getEnrichedActions(this._actions)
        : collapseActions(this._actions);

      this._emitGenerationStatus({ status: 'writing', message: 'AI writing test...', progress: 50 });
      const result = await exportSession(enrichedActions, {
        scenarioName,
        outputFile,
        wsEndpoint: this.wsEndpointForTest,
        pageHasWebSockets: false,
      });

      await fs.promises.writeFile(outputFile, result.code, 'utf-8');

      this._emitGenerationStatus({ status: 'running', message: 'Running generated test...', progress: 75 });
      const runResult = await this._runGeneratedTest(outputFile);

      if (runResult.passed) {
        this._emitGenerationStatus({ status: 'done', message: `Test passed in ${runResult.durationMs}ms`, progress: 100, outputFile });
      } else {
        const chat = new Chat(this.wsEndpointForTest!);
        await this._repairAndRerun(chat, result.code, outputFile, runResult.error ?? 'Test failed', 1);
      }
    } catch (error: any) {
      this._emitGenerationStatus({ status: 'error', message: String(error?.message ?? error), progress: 0 });
    }
  }

  private async _runGeneratedTest(outputFile: string): Promise<{ passed: boolean; durationMs: number; error?: string }> {
    const start = Date.now();
    return new Promise(resolve => {
      const { spawn } = require('child_process');
      const proc = spawn('npx', ['playwright', 'test', outputFile, '--reporter=json'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => stdout += d.toString());
      proc.stderr?.on('data', (d: Buffer) => stderr += d.toString());
      proc.on('close', (code: number) => {
        const durationMs = Date.now() - start;
        if (code === 0) {
          resolve({ passed: true, durationMs });
          return;
        }
        // Try to extract error from JSON reporter output
        try {
          const report = JSON.parse(stdout);
          const failed = report?.suites?.[0]?.specs?.[0]?.tests?.[0]?.results?.[0];
          const errorMsg = failed?.error?.message ?? stderr.slice(0, 1000);
          resolve({ passed: false, durationMs, error: errorMsg });
        } catch {
          resolve({ passed: false, durationMs, error: stderr.slice(0, 1000) || 'Test failed' });
        }
      });
      proc.on('error', (err: Error) => {
        resolve({ passed: false, durationMs: Date.now() - start, error: err.message });
      });
    });
  }

  private async _repairAndRerun(chat: Chat, code: string, outputFile: string, error: string, attempt: number): Promise<void> {
    if (attempt > 3) {
      this._emitGenerationStatus({
        status: 'error',
        message: `Test failed after ${attempt - 1} repair attempt(s). Last error: ${error.slice(0, 200)}`,
        progress: 0,
      });
      return;
    }

    this._emitGenerationStatus({
      status: 'repairing',
      message: `Repair attempt ${attempt}/3...`,
      progress: 75 + attempt * 5,
    });

    const repairPrompt = `The following Playwright test failed. Please fix it.

## Failed Test
\`\`\`typescript
${code}
\`\`\`

## Error
${error}

## Output Format
Return the fixed TypeScript code as a raw JSON string. Your entire response must be valid JSON parseable by JSON.parse().
Example: "import { test, expect } from '@playwright/test';\\n\\ntest.describe(..."
Do not include any explanation, markdown fences, or wrapper objects.
The code must start with: import { test, expect } from '@playwright/test';`;

    const fixedCode = await chat.post<string>(repairPrompt);
    if (!fixedCode) {
      this._emitGenerationStatus({ status: 'error', message: 'AI repair failed', progress: 0 });
      return;
    }

    await fs.promises.writeFile(outputFile, fixedCode, 'utf-8');
    const runResult = await this._runGeneratedTest(outputFile);

    if (runResult.passed)
      this._emitGenerationStatus({ status: 'done', message: `Test passed after ${attempt} repair(s)`, progress: 100, outputFile });
    else
      await this._repairAndRerun(chat, fixedCode, outputFile, runResult.error ?? 'Test failed', attempt + 1);
  }
}

// For example, if the SDK language is 'javascript', this returns 'playwright-test'.
function determinePrimaryGeneratorId(sdkLanguage: Language): string {
  for (const language of languageSet()) {
    if (language.highlighter === sdkLanguage)
      return language.id;
  }
  return sdkLanguage;
}

export class ProgrammaticRecorderApp {
  static async run(inspectedContext: BrowserContext, recorder: Recorder, browserName: string, params: channels.BrowserContextEnableRecorderParams) {
    let lastAction: actions.ActionInContext | null = null;
    const languages = [...languageSet()];

    const languageGeneratorOptions = {
      browserName: browserName,
      launchOptions: { headless: false, ...params.launchOptions, tracesDir: undefined },
      contextOptions: { ...params.contextOptions },
      deviceName: params.device,
      saveStorage: params.saveStorage,
    };
    const languageGenerator = languages.find(l => l.id === params.language) ?? languages.find(l => l.id === 'playwright-test')!;

    recorder.on(RecorderEvent.ActionAdded, action => {
      const page = findPageByGuid(inspectedContext, action.frame.pageGuid);
      if (!page)
        return;
      const { actionTexts } = generateCode([action], languageGenerator, languageGeneratorOptions);
      if (!lastAction || !shouldMergeAction(action, lastAction))
        inspectedContext.emit(BrowserContext.Events.RecorderEvent, { event: 'actionAdded', data: action, page, code: actionTexts.join('\n') });
      else
        inspectedContext.emit(BrowserContext.Events.RecorderEvent, { event: 'actionUpdated', data: action, page, code: actionTexts.join('\n') });
      lastAction = action;
    });
    recorder.on(RecorderEvent.SignalAdded, signal => {
      const page = findPageByGuid(inspectedContext, signal.frame.pageGuid);
      if (!page)
        return;
      inspectedContext.emit(BrowserContext.Events.RecorderEvent, { event: 'signalAdded', data: signal, page, code: '' });
    });
  }
}

function findPageByGuid(context: BrowserContext, guid: string) {
  return context.pages().find(p => p.guid === guid);
}

function createRecorderFrontend(page: Page): RecorderFrontend {
  return new Proxy({} as RecorderFrontend, {
    get: (_target, prop: string | symbol) => {
      if (typeof prop !== 'string')
        return undefined;
      return (params: any) => {
        page.mainFrame().evaluateExpression(((event: { method: string, params?: any }) => {
          window.dispatch(event);
        }).toString(), { isFunction: true }, { method: prop, params }).catch(() => {});
      };
    },
  });
}

const recorderAppSymbol = Symbol('recorderApp');
