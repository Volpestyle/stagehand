import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import {
  ApiResponse,
  ExecuteActionParams,
  StagehandAPIConstructorParams,
  StartSessionParams,
  StartSessionResult,
  ProviderType,
} from "../types/api";
import { LogLine } from "../types/log";
import { GotoOptions } from "../types/playwright";
import {
  ActOptions,
  ActResult,
  AgentConfig,
  ExtractOptions,
  ExtractResult,
  ObserveOptions,
  ObserveResult,
} from "../types/stagehand";
import { AgentExecuteOptions, AgentResult } from ".";
import {
  StagehandAPIUnauthorizedError,
  StagehandHttpError,
  StagehandAPIError,
  StagehandServerError,
  StagehandResponseBodyError,
  StagehandResponseParseError,
} from "../types/stagehandApiErrors";
import makeFetchCookie from "fetch-cookie";
import { STAGEHAND_VERSION } from "./version";

interface ProviderConfig {
  headers: {
    apiKey: string;
    projectId: string;
    sessionId: string;
    streamResponse: string;
    modelApiKey: string;
    sentAt: string;
    language: string;
    sdkVersion: string;
  };
  baseURL: string;
}

export class StagehandAPI {
  private apiKey: string;
  private projectId: string;
  private sessionId?: string;
  private modelApiKey: string;
  private logger: (message: LogLine) => void;
  private fetchWithCookies;
  private provider: ProviderType;

  constructor({
    apiKey,
    projectId,
    logger,
    provider,
  }: StagehandAPIConstructorParams) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.logger = logger;
    this.provider = provider;
    // Create a single cookie jar instance that will persist across all requests
    this.fetchWithCookies = makeFetchCookie(fetch);
  }

  async init({
    modelName,
    modelApiKey,
    domSettleTimeoutMs,
    verbose,
    debugDom,
    systemPrompt,
    selfHeal,
    waitForCaptchaSolves,
    actionTimeoutMs,
    browserbaseSessionCreateParams,
    browserbaseSessionID,
  }: StartSessionParams): Promise<StartSessionResult> {
    if (!modelApiKey) {
      throw new StagehandAPIError("modelApiKey is required");
    }
    this.modelApiKey = modelApiKey;

    const region = browserbaseSessionCreateParams?.region;
    if (region && region !== "us-east-1") {
      return { sessionId: browserbaseSessionID ?? null, available: false };
    }
    const sessionResponse = await this.request("/sessions/start", {
      method: "POST",
      body: JSON.stringify({
        modelName,
        domSettleTimeoutMs,
        verbose,
        debugDom,
        systemPrompt,
        selfHeal,
        waitForCaptchaSolves,
        actionTimeoutMs,
        browserbaseSessionCreateParams,
        browserbaseSessionID,
      }),
    });

    if (sessionResponse.status === 401) {
      throw new StagehandAPIUnauthorizedError(
        "Unauthorized. Ensure you provided a valid API key and that it is whitelisted.",
      );
    } else if (sessionResponse.status !== 200) {
      console.log(await sessionResponse.text());
      throw new StagehandHttpError(`Unknown error: ${sessionResponse.status}`);
    }

    const sessionResponseBody =
      (await sessionResponse.json()) as ApiResponse<StartSessionResult>;

    if (sessionResponseBody.success === false) {
      throw new StagehandAPIError(sessionResponseBody.message);
    }

    this.sessionId = sessionResponseBody.data.sessionId;

    // Temporary reroute for rollout
    if (!sessionResponseBody.data?.available && browserbaseSessionID) {
      sessionResponseBody.data.sessionId = browserbaseSessionID;
    }

    return sessionResponseBody.data;
  }

  async act(options: ActOptions | ObserveResult): Promise<ActResult> {
    return this.execute<ActResult>({
      method: "act",
      args: { ...options },
    });
  }

  async extract<T extends z.AnyZodObject>(
    options: ExtractOptions<T>,
  ): Promise<ExtractResult<T>> {
    if (!options.schema) {
      return this.execute<ExtractResult<T>>({
        method: "extract",
        args: {},
      });
    }
    const parsedSchema = zodToJsonSchema(options.schema);
    return this.execute<ExtractResult<T>>({
      method: "extract",
      args: { ...options, schemaDefinition: parsedSchema },
    });
  }

  async observe(options?: ObserveOptions): Promise<ObserveResult[]> {
    return this.execute<ObserveResult[]>({
      method: "observe",
      args: { ...options },
    });
  }

  async goto(url: string, options?: GotoOptions): Promise<void> {
    return this.execute<void>({
      method: "navigate",
      args: { url, options },
    });
  }

  async agentExecute(
    agentConfig: AgentConfig,
    executeOptions: AgentExecuteOptions,
  ): Promise<AgentResult> {
    return this.execute<AgentResult>({
      method: "agentExecute",
      args: { agentConfig, executeOptions },
    });
  }

  async end(): Promise<Response> {
    const url = `/sessions/${this.sessionId}/end`;
    const response = await this.request(url, {
      method: "POST",
    });
    return response;
  }

  private async execute<T>({
    method,
    args,
    params,
  }: ExecuteActionParams): Promise<T> {
    const urlParams = new URLSearchParams(params as Record<string, string>);
    const queryString = urlParams.toString();
    const url = `/sessions/${this.sessionId}/${method}${queryString ? `?${queryString}` : ""}`;

    const response = await this.request(url, {
      method: "POST",
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new StagehandHttpError(
        `HTTP error! status: ${response.status}, body: ${errorBody}`,
      );
    }

    if (!response.body) {
      throw new StagehandResponseBodyError();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done && !buffer) {
        return null;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const eventData = JSON.parse(line.slice(6));

          if (eventData.type === "system") {
            if (eventData.data.status === "error") {
              throw new StagehandServerError(eventData.data.error);
            }
            if (eventData.data.status === "finished") {
              return eventData.data.result as T;
            }
          } else if (eventData.type === "log") {
            this.logger(eventData.data.message);
          }
        } catch (e) {
          console.error("Error parsing event data:", e);
          throw new StagehandResponseParseError(
            "Failed to parse server response",
          );
        }
      }

      if (done) break;
    }
  }

  private getProviderConfig(): ProviderConfig {
    switch (this.provider) {
      case "wallcrawler":
        return {
          headers: {
            apiKey: "x-wc-api-key",
            projectId: "x-wc-project-id",
            sessionId: "x-wc-session-id",
            streamResponse: "x-stream-response",
            modelApiKey: "x-model-api-key",
            sentAt: "x-sent-at",
            language: "x-language",
            sdkVersion: "x-sdk-version",
          },
          baseURL: process.env.WALLCRAWLER_API_URL,
        };
      case "browserbase":
      default:
        return {
          headers: {
            apiKey: "x-bb-api-key",
            projectId: "x-bb-project-id",
            sessionId: "x-bb-session-id",
            streamResponse: "x-stream-response",
            modelApiKey: "x-model-api-key",
            sentAt: "x-sent-at",
            language: "x-language",
            sdkVersion: "x-sdk-version",
          },
          baseURL:
            process.env.STAGEHAND_API_URL ??
            "https://api.stagehand.browserbase.com/v1",
        };
    }
  }

  private async request(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const config = this.getProviderConfig();

    const defaultHeaders: Record<string, string> = {
      [config.headers.apiKey]: this.apiKey,
      [config.headers.projectId]: this.projectId,
      [config.headers.sessionId]: this.sessionId,
      // we want real-time logs, so we stream the response
      [config.headers.streamResponse]: "true",
      [config.headers.modelApiKey]: this.modelApiKey,
      [config.headers.sentAt]: new Date().toISOString(),
      [config.headers.language]: "typescript",
      [config.headers.sdkVersion]: STAGEHAND_VERSION,
    };

    if (options.method === "POST" && options.body) {
      defaultHeaders["Content-Type"] = "application/json";
    }

    const response = await this.fetchWithCookies(`${config.baseURL}${path}`, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
    });

    return response;
  }
}
