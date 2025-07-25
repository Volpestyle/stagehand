import { Browserbase } from "@browserbasehq/sdk";
import { LogLine } from "./log";

export type ProviderType = "browserbase" | "wallcrawler";

export interface ProviderConfig {
  type: ProviderType;
  headers: {
    apiKey: string;
    projectId: string;
    sessionId: string;
  };
  baseURL: string;
}

export interface StagehandAPIConstructorParams {
  apiKey: string;
  projectId: string;
  logger: (message: LogLine) => void;
  provider?: ProviderType; // Optional, defaults to "browserbase" for backwards compatibility
}

export interface ExecuteActionParams {
  method: "act" | "extract" | "observe" | "navigate" | "end" | "agentExecute";
  args?: unknown;
  params?: unknown;
}

export interface StartSessionParams {
  modelName: string;
  modelApiKey: string;
  domSettleTimeoutMs: number;
  verbose: number;
  debugDom: boolean;
  systemPrompt?: string;
  browserbaseSessionCreateParams?: Browserbase.Sessions.SessionCreateParams;
  selfHeal?: boolean;
  waitForCaptchaSolves?: boolean;
  actionTimeoutMs?: number;
  browserbaseSessionID?: string;
}

export interface StartSessionResult {
  sessionId: string;
  available?: boolean;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  message: string;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;
