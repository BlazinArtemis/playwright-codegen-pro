/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import type { Language } from '../../playwright-core/src/utils/isomorphic/locatorGenerators';
import type { AriaTemplateNode } from '@isomorphic/ariaSnapshot';

export type Point = { x: number; y: number };

export type Mode =
  | 'inspecting'
  | 'recording'
  | 'none'
  | 'assertingText'
  | 'recording-inspecting'
  | 'standby'
  | 'assertingVisibility'
  | 'assertingValue'
  | 'assertingSnapshot'
  | 'generating';

export type ElementInfo = {
  selector: string;
  ariaSnapshot: string;
};

export type EventData = {
  event:
    | 'clear'
    | 'resume'
    | 'step'
    | 'pause'
    | 'setMode'
    | 'highlightRequested'
    | 'languageChanged';
  params: any;
};

export type OverlayState = {
  offsetX: number;
};

export type GenerationStatus =
  | 'idle' | 'finalizing' | 'analyzing' | 'writing'
  | 'running' | 'repairing' | 'done' | 'error'
  | 'exported';

export type GenerationStatusEvent = {
  status: GenerationStatus;
  message: string;
  progress: number; // 0–100
  outputFile?: string; // set only when status === 'done'
  promptFilePath?: string; // set only when status === 'exported'
};

export type NetworkPanelEntry = {
  url: string;
  method: string;
  status?: number;
  bucket: 'direct' | 'pageLoad' | 'noise' | 'aborted';
  linkedStepIndex?: number;
  operationName?: string;
};

export type UIState = {
  mode: Mode;
  actionPoint?: Point;
  actionSelector?: string;
  ariaTemplate?: AriaTemplateNode;
  language: Language;
  testIdAttributeName: string;
  overlay: OverlayState;
  generationStatus?: GenerationStatusEvent;
  networkEntries?: NetworkPanelEntry[];
  scenarioName?: string;
};

export type CallLogStatus = 'in-progress' | 'done' | 'error' | 'paused';

export type CallLog = {
  id: string;
  title: string;
  messages: string[];
  status: CallLogStatus;
  error?: string;
  reveal?: boolean;
  duration?: number;
  params: {
    url?: string;
    selector?: string;
  };
};

export type SourceHighlight = {
  line: number;
  type: 'running' | 'paused' | 'error';
};

export type Source = {
  isRecorded: boolean;
  id: string;
  label: string;
  text: string;
  language: Language;
  highlight: SourceHighlight[];
  revealLine?: number;
  // used to group the language generators
  group?: string;
  header?: string;
  footer?: string;
  actions?: string[];
};

declare global {
  interface Window {
    playwrightSourcesEchoForTest: Source[];
    sendCommand(data: { method: string; params?: any }): Promise<void>;
    dispatch(data: { method: string; params?: any }): void;
  }
}

export interface RecorderBackend {
  setMode(params: { mode: Mode }): Promise<void>;
  setAutoExpect(params: { autoExpect: boolean }): Promise<void>;
  resume(): Promise<void>;
  pause(): Promise<void>;
  step(): Promise<void>;
  highlightRequested(params: { selector?: string; ariaTemplate?: AriaTemplateNode }): Promise<void>;
  fileChanged(params: { fileId: string }): Promise<void>;
  clear(): Promise<void>;
  generateTest(params: { scenarioName: string; outputFile: string }): Promise<void>;
  setScenarioName(params: { name: string }): Promise<void>;
}

export interface RecorderFrontend {
  modeChanged: (params: { mode: Mode }) => void;
  pauseStateChanged: (params: { paused: boolean }) => void;
  sourcesUpdated: (params: { sources: Source[] }) => void;
  sourceRevealRequested: (params: { sourceId: string }) => void;
  pageNavigated: (params: { url: string | undefined }) => void;
  callLogsUpdated: (params: { callLogs: CallLog[] }) => void;
  elementPicked: (params: { elementInfo: ElementInfo, userGesture?: boolean }) => void;
  generationStatusChanged: (params: GenerationStatusEvent) => void;
  networkEntriesUpdated: (params: { entries: NetworkPanelEntry[] }) => void;
  promptReady: (params: { prompt: string; filePath: string }) => void;
  configUpdated: (params: { aiCodegen: boolean }) => void;
}
