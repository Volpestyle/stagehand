import { LogLine } from "./log";

export interface StagehandAPIConstructorParams {
  apiKey: string;
  projectId: string;
  logger: (message: LogLine) => void;
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
  selfHeal?: boolean;
  waitForCaptchaSolves?: boolean;
  actionTimeoutMs?: number;
  sessionId?: string;
  /**
   * @deprecated Use sessionId and provider configuration instead
   */
  browserbaseSessionCreateParams?: Record<string, unknown>;
  /**
   * @deprecated Use sessionId instead
   */
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
