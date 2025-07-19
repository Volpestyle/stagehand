import { Browser } from 'playwright';
import fs from 'fs';
import dotenv from 'dotenv';
import { BrowserResult } from '../types/browser';
import { EnhancedContext } from '../types/context';
import { LogLine } from '../types/log';
import { AvailableModel } from '../types/model';
import { Page } from '../types/page';
import {
  ConstructorParams,
  InitResult,
  AgentConfig,
  StagehandMetrics,
  StagehandFunctionName,
  HistoryEntry,
  ActOptions,
  ExtractOptions,
  ObserveOptions,
} from '../types/stagehand';
import { StagehandContext } from './StagehandContext';
import { StagehandPage } from './StagehandPage';
import { StagehandAPI } from './api';
import { scriptContent } from './dom/build/scriptContent';
import { LLMClient } from './llm/LLMClient';
import { LLMProvider } from './llm/LLMProvider';
import { ClientOptions } from '../types/model';
import { isRunningInBun, loadApiKeyFromEnv } from './utils';
import { ApiResponse, ErrorResponse } from '@/types/api';
import { AgentExecuteOptions, AgentResult } from '../types/agent';
import { StagehandAgentHandler } from './handlers/agentHandler';
import { StagehandOperatorHandler } from './handlers/operatorHandler';
import { StagehandLogger } from './logger';
import { getBrowserWithProvider } from './browserConnection';
import { ProviderType, IBrowserProvider, Artifact, ArtifactList } from './providers';
import { ScreencastOptions, InputEvent, ScreencastFrame } from '@wallcrawler/infra-common';

// Type guard to check if provider supports screencast
function hasScreencastCapabilities(provider: IBrowserProvider): boolean {
  return (
    typeof provider.startScreencast === 'function' &&
    typeof provider.stopScreencast === 'function' &&
    typeof provider.sendInput === 'function'
  );
}

import {
  StagehandError,
  StagehandNotInitializedError,
  UnsupportedAISDKModelProviderError,
  InvalidAISDKModelFormatError,
  StagehandInitError,
} from '../types/stagehandErrors';
import { z } from 'zod';
import { GotoOptions } from '@/types/playwright';

dotenv.config({ path: '.env' });

const DEFAULT_MODEL_NAME = 'gpt-4o';

// Initialize the global logger
let globalLogger: StagehandLogger;

const defaultLogger = async (logLine: LogLine, disablePino?: boolean) => {
  if (!globalLogger) {
    globalLogger = new StagehandLogger(
      {
        pretty: true,
        usePino: !disablePino,
      },
      undefined
    );
  }
  globalLogger.log(logLine);
};

export class Stagehand {
  private stagehandPage!: StagehandPage;
  private stagehandContext!: StagehandContext;

  // Provider system
  private provider: IBrowserProvider;
  private _providerType: ProviderType;
  public sessionId?: string;

  // Core settings
  public readonly domSettleTimeoutMs: number;
  public readonly debugDom: boolean;
  public readonly headless: boolean;
  public verbose: 0 | 1 | 2;
  public llmProvider: LLMProvider;
  public enableCaching: boolean;
  public variables: { [key: string]: unknown };
  private contextPath?: string;
  public llmClient: LLMClient;
  public readonly userProvidedInstructions?: string;
  private usingAPI: boolean;
  private modelName: AvailableModel;
  public apiClient: StagehandAPI | undefined;
  public readonly waitForCaptchaSolves: boolean;
  public readonly selfHeal: boolean;
  private cleanupCalled = false;
  public readonly actTimeoutMs: number;
  public readonly logInferenceToFile?: boolean;
  private stagehandLogger: StagehandLogger;
  private disablePino: boolean;
  private modelClientOptions: ClientOptions;
  private _browser: Browser | undefined;
  private _isClosed: boolean = false;
  private _history: Array<HistoryEntry> = [];
  public readonly experimental: boolean;
  private externalLogger?: (logLine: LogLine) => void;

  public get history(): ReadonlyArray<HistoryEntry> {
    return Object.freeze([...this._history]);
  }
  protected setActivePage(page: StagehandPage): void {
    this.stagehandPage = page;
  }

  public get page(): Page {
    if (!this.stagehandContext) {
      throw new StagehandNotInitializedError('page');
    }
    return this.stagehandPage.page;
  }

  public stagehandMetrics: StagehandMetrics = {
    actPromptTokens: 0,
    actCompletionTokens: 0,
    actInferenceTimeMs: 0,
    extractPromptTokens: 0,
    extractCompletionTokens: 0,
    extractInferenceTimeMs: 0,
    observePromptTokens: 0,
    observeCompletionTokens: 0,
    observeInferenceTimeMs: 0,
    agentPromptTokens: 0,
    agentCompletionTokens: 0,
    agentInferenceTimeMs: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalInferenceTimeMs: 0,
  };

  public get metrics(): StagehandMetrics {
    return this.stagehandMetrics;
  }

  public get isClosed(): boolean {
    return this._isClosed;
  }

  public updateMetrics(
    functionName: StagehandFunctionName,
    promptTokens: number,
    completionTokens: number,
    inferenceTimeMs: number
  ): void {
    switch (functionName) {
      case StagehandFunctionName.ACT:
        this.stagehandMetrics.actPromptTokens += promptTokens;
        this.stagehandMetrics.actCompletionTokens += completionTokens;
        this.stagehandMetrics.actInferenceTimeMs += inferenceTimeMs;
        break;

      case StagehandFunctionName.EXTRACT:
        this.stagehandMetrics.extractPromptTokens += promptTokens;
        this.stagehandMetrics.extractCompletionTokens += completionTokens;
        this.stagehandMetrics.extractInferenceTimeMs += inferenceTimeMs;
        break;

      case StagehandFunctionName.OBSERVE:
        this.stagehandMetrics.observePromptTokens += promptTokens;
        this.stagehandMetrics.observeCompletionTokens += completionTokens;
        this.stagehandMetrics.observeInferenceTimeMs += inferenceTimeMs;
        break;

      case StagehandFunctionName.AGENT:
        this.stagehandMetrics.agentPromptTokens += promptTokens;
        this.stagehandMetrics.agentCompletionTokens += completionTokens;
        this.stagehandMetrics.agentInferenceTimeMs += inferenceTimeMs;
        break;
    }
    this.updateTotalMetrics(promptTokens, completionTokens, inferenceTimeMs);
  }

  private updateTotalMetrics(promptTokens: number, completionTokens: number, inferenceTimeMs: number): void {
    this.stagehandMetrics.totalPromptTokens += promptTokens;
    this.stagehandMetrics.totalCompletionTokens += completionTokens;
    this.stagehandMetrics.totalInferenceTimeMs += inferenceTimeMs;
  }

  constructor({
    provider,
    verbose,
    llmProvider,
    llmClient,
    logger,
    domSettleTimeoutMs,
    enableCaching,
    sessionId,
    modelName,
    modelClientOptions,
    systemPrompt,
    waitForCaptchaSolves = false,
    logInferenceToFile = false,
    selfHeal = false,
    disablePino,
    experimental = false,
  }: ConstructorParams = {}) {
    this.externalLogger = logger || ((logLine: LogLine) => defaultLogger(logLine, disablePino));

    // Initialize the Stagehand logger
    this.stagehandLogger = new StagehandLogger(
      {
        pretty: true,
        // use pino if pino is enabled, and there is no custom logger
        usePino: !logger && !disablePino,
      },
      this.externalLogger
    );

    this.enableCaching = enableCaching ?? (process.env.ENABLE_CACHING && process.env.ENABLE_CACHING === 'true');

    this.llmProvider = llmProvider || new LLMProvider(this.logger, this.enableCaching);

    // Initialize provider system
    this.initializeProvider(provider);

    this.sessionId = sessionId;

    this.verbose = verbose ?? 0;
    // Update logger verbosity level
    this.stagehandLogger.setVerbosity(this.verbose);
    this.modelName = modelName ?? DEFAULT_MODEL_NAME;

    let modelApiKey: string | undefined;

    if (!modelClientOptions?.apiKey) {
      // If no API key is provided, try to load it from the environment
      if (LLMProvider.getModelProvider(this.modelName) === 'aisdk') {
        modelApiKey = loadApiKeyFromEnv(this.modelName.split('/')[0], this.logger);
      } else {
        // Temporary add for legacy providers
        modelApiKey =
          LLMProvider.getModelProvider(this.modelName) === 'openai'
            ? process.env.OPENAI_API_KEY || this.llmClient?.clientOptions?.apiKey
            : LLMProvider.getModelProvider(this.modelName) === 'anthropic'
              ? process.env.ANTHROPIC_API_KEY || this.llmClient?.clientOptions?.apiKey
              : LLMProvider.getModelProvider(this.modelName) === 'google'
                ? process.env.GOOGLE_API_KEY || this.llmClient?.clientOptions?.apiKey
                : undefined;
      }
      this.modelClientOptions = {
        ...modelClientOptions,
        apiKey: modelApiKey,
      };
    } else {
      this.modelClientOptions = modelClientOptions;
    }

    if (llmClient) {
      this.llmClient = llmClient;
    } else {
      try {
        // try to set a default LLM client
        this.llmClient = this.llmProvider.getClient(this.modelName, this.modelClientOptions);
      } catch (error) {
        if (error instanceof UnsupportedAISDKModelProviderError || error instanceof InvalidAISDKModelFormatError) {
          throw error;
        }
        this.llmClient = undefined;
      }
    }

    this.domSettleTimeoutMs = domSettleTimeoutMs ?? 30_000;
    this.headless = false; // Will be set by provider-specific options
    this.userProvidedInstructions = systemPrompt;
    this.usingAPI = false; // Always use provider system
    this.waitForCaptchaSolves = waitForCaptchaSolves;
    this.logInferenceToFile = logInferenceToFile;
    this.selfHeal = selfHeal;
    this.disablePino = disablePino;
    this.experimental = experimental;
    if (this.experimental) {
      this.stagehandLogger.warn('Experimental mode is enabled. This is a beta feature and may break at any time.');
    }
  }

  private initializeProvider(provider?: IBrowserProvider): void {
    if (!provider) {
      throw new StagehandError(
        `No provider instance provided. Please install and use a provider package:\n` +
          `- For local: npm install @wallcrawler/infra/local\n` +
          `- For AWS: npm install @wallcrawler/infra/aws\n\n` +
          `Example usage:\n` +
          `import { LocalProvider } from '@wallcrawler/infra/local';\n` +
          `const provider = new LocalProvider();\n` +
          `const stagehand = new Stagehand({ provider });`
      );
    }

    this.provider = provider;
    this._providerType = provider.type;
  }

  private registerSignalHandlers() {
    const cleanup = async (signal: string) => {
      if (this.cleanupCalled) return;
      this.cleanupCalled = true;

      this.stagehandLogger.info(`[${signal}] received. Ending ${this._providerType} session...`);
      try {
        await this.close();
      } catch (err) {
        this.stagehandLogger.error(`Error ending ${this._providerType} session:`, {
          error: String(err),
        });
      } finally {
        // Exit explicitly once cleanup is done
        process.exit(0);
      }
    };

    process.once('SIGINT', () => void cleanup('SIGINT'));
    process.once('SIGTERM', () => void cleanup('SIGTERM'));
  }

  public get logger(): (logLine: LogLine) => void {
    return (logLine: LogLine) => {
      this.log(logLine);
    };
  }

  public get providerType(): ProviderType {
    return this._providerType;
  }

  public get context(): EnhancedContext {
    if (!this.stagehandContext) {
      throw new StagehandNotInitializedError('context');
    }
    return this.stagehandContext.context;
  }

  async init(): Promise<InitResult> {
    if (isRunningInBun()) {
      throw new StagehandError(
        'Playwright does not currently support the Bun runtime environment. ' +
          'Please use Node.js instead. For more information, see: ' +
          'https://github.com/microsoft/playwright/issues/27139'
      );
    }

    const {
      provider: _provider,
      browser,
      context,
      debugUrl,
      sessionUrl,
      contextPath,
      sessionId,
    } = await getBrowserWithProvider({
      provider: this.provider,
      sessionId: this.sessionId,
      headless: this.headless,
      logger: this.logger,
    }).catch((e) => {
      this.stagehandLogger.error('Error in init:', { error: String(e) });
      const br: BrowserResult = {
        provider: this._providerType,
        context: undefined,
        debugUrl: undefined,
        sessionUrl: undefined,
        sessionId: undefined,
      };
      return br;
    });
    this.contextPath = contextPath;
    this._browser = browser;
    if (!context) {
      const errorMessage = 'The browser context is undefined. This means the CDP connection to the browser failed';
      this.stagehandLogger.error(
        this._providerType === 'local'
          ? `${errorMessage}. If running locally, please check if the browser is running and the port is open.`
          : errorMessage
      );
      throw new StagehandInitError(errorMessage);
    }
    this.stagehandContext = await StagehandContext.init(context, this);

    const defaultPage = (await this.stagehandContext.getStagehandPages())[0];
    this.stagehandPage = defaultPage;

    if (this.headless) {
      await this.page.setViewportSize({ width: 1280, height: 720 });
    }

    const guardedScript = `
  if (!window.__stagehandInjected) {
    window.__stagehandInjected = true;
    ${scriptContent}
  }
`;
    await this.context.addInitScript({
      content: guardedScript,
    });

    this.sessionId = sessionId;

    return { debugUrl, sessionUrl, sessionId };
  }

  log(logObj: LogLine): void {
    logObj.level = logObj.level ?? 1;

    // Use our Pino-based logger
    this.stagehandLogger.log(logObj);
  }

  async close(): Promise<void> {
    // Stop any active screencast
    try {
      await this.stopScreencast();
    } catch {
      // Ignore errors during cleanup
    }

    this._isClosed = true;
    if (this.apiClient) {
      const response = await this.apiClient.end();
      const body: ApiResponse<unknown> = await response.json();
      if (!body.success) {
        if (response.status == 409) {
          this.log({
            category: 'close',
            message: 'Warning: attempted to end a session that is not currently active',
            level: 0,
          });
        } else {
          throw new StagehandError((body as ErrorResponse).message);
        }
      }
      this.apiClient = null;
      return;
    } else {
      await this.context.close();
      if (this._browser) {
        await this._browser.close();
      }
    }

    if (this.contextPath) {
      try {
        fs.rmSync(this.contextPath, { recursive: true, force: true });
      } catch (e) {
        console.error('Error deleting context directory:', e);
      }
    }
  }

  public addToHistory(
    method: HistoryEntry['method'],
    parameters:
      | ActOptions
      | ExtractOptions<z.AnyZodObject>
      | ObserveOptions
      | { url: string; options: GotoOptions }
      | string,
    result?: unknown
  ): void {
    this._history.push({
      method,
      parameters,
      result: result ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Create an agent instance that can be executed with different instructions
   * @returns An agent instance with execute() method
   */
  agent(options?: AgentConfig): {
    execute: (instructionOrOptions: string | AgentExecuteOptions) => Promise<AgentResult>;
  } {
    if (!options || !options.provider) {
      // use open operator agent
      return {
        execute: async (instructionOrOptions: string | AgentExecuteOptions) => {
          return new StagehandOperatorHandler(this.stagehandPage, this.logger, this.llmClient).execute(
            instructionOrOptions
          );
        },
      };
    }

    const agentHandler = new StagehandAgentHandler(this, this.stagehandPage, this.logger, {
      modelName: options.model,
      clientOptions: options.options,
      userProvidedInstructions:
        options.instructions ??
        `You are a helpful assistant that can use a web browser.
      You are currently on the following page: ${this.stagehandPage.page.url()}.
      Do not ask follow up questions, the user will trust your judgement.`,
      agentType: options.provider,
    });

    this.log({
      category: 'agent',
      message: 'Creating agent instance',
      level: 1,
    });

    return {
      execute: async (instructionOrOptions: string | AgentExecuteOptions) => {
        const executeOptions: AgentExecuteOptions =
          typeof instructionOrOptions === 'string' ? { instruction: instructionOrOptions } : instructionOrOptions;

        if (!executeOptions.instruction) {
          throw new StagehandError('Instruction is required for agent execution');
        }

        if (this.usingAPI) {
          if (!this.apiClient) {
            throw new StagehandNotInitializedError('API client');
          }

          if (!options.options) {
            options.options = {};
          }

          if (options.provider === 'anthropic') {
            options.options.apiKey = process.env.ANTHROPIC_API_KEY;
          } else if (options.provider === 'openai') {
            options.options.apiKey = process.env.OPENAI_API_KEY;
          } else if (options.provider === 'google') {
            options.options.apiKey = process.env.GOOGLE_API_KEY;
          }

          if (!options.options.apiKey) {
            throw new StagehandError(
              `API key not found for \`${options.provider}\` provider. Please set the ${options.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} environment variable or pass an apiKey in the options object.`
            );
          }

          return await this.apiClient.agentExecute(options, executeOptions);
        }

        return await agentHandler.execute(executeOptions);
      },
    };
  }

  /**
   * Save an artifact to provider storage
   * @param filePath - Path to the file to save
   * @param data - File data as Buffer
   * @returns Artifact information
   */
  async saveArtifact(filePath: string, data: Buffer): Promise<Artifact> {
    if (!this.sessionId) {
      throw new StagehandError('No active session - cannot save artifact');
    }

    if (!this.provider) {
      throw new StagehandError('Provider not initialized - cannot save artifact');
    }

    this.log({
      category: 'artifact',
      message: 'saving artifact',
      level: 1,
      auxiliary: {
        filePath: { value: filePath, type: 'string' },
        size: { value: data.length.toString(), type: 'integer' },
        providerType: { value: this._providerType, type: 'string' },
      },
    });

    try {
      const artifact = await this.provider.saveArtifact(this.sessionId, filePath, data);

      this.log({
        category: 'artifact',
        message: 'artifact saved successfully',
        level: 1,
        auxiliary: {
          artifactId: { value: artifact.id, type: 'string' },
          name: { value: artifact.name, type: 'string' },
          size: { value: artifact.size.toString(), type: 'integer' },
        },
      });

      return artifact;
    } catch (error) {
      this.log({
        category: 'artifact',
        message: 'failed to save artifact',
        level: 0,
        auxiliary: {
          error: { value: (error as Error).message, type: 'string' },
        },
      });
      throw error;
    }
  }

  /**
   * List artifacts for the current session
   * @param cursor - Optional pagination cursor
   * @returns List of artifacts with pagination info
   */
  async getArtifacts(cursor?: string): Promise<ArtifactList> {
    if (!this.sessionId) {
      throw new StagehandError('No active session - cannot list artifacts');
    }

    if (!this.provider) {
      throw new StagehandError('Provider not initialized - cannot list artifacts');
    }

    this.log({
      category: 'artifact',
      message: 'listing artifacts',
      level: 1,
      auxiliary: {
        sessionId: { value: this.sessionId, type: 'string' },
        providerType: { value: this._providerType, type: 'string' },
      },
    });

    try {
      const artifactList = await this.provider.getArtifacts(this.sessionId, cursor);

      this.log({
        category: 'artifact',
        message: 'artifacts listed successfully',
        level: 1,
        auxiliary: {
          count: {
            value: artifactList.artifacts.length.toString(),
            type: 'integer',
          },
          totalCount: {
            value: artifactList.totalCount.toString(),
            type: 'integer',
          },
          hasMore: { value: artifactList.hasMore.toString(), type: 'boolean' },
        },
      });

      return artifactList;
    } catch (error) {
      this.log({
        category: 'artifact',
        message: 'failed to list artifacts',
        level: 0,
        auxiliary: {
          error: { value: (error as Error).message, type: 'string' },
        },
      });
      throw error;
    }
  }

  /**
   * Download a specific artifact
   * @param artifactId - Unique identifier for the artifact
   * @returns Artifact data as Buffer
   */
  async downloadArtifact(artifactId: string): Promise<Buffer> {
    if (!this.sessionId) {
      throw new StagehandError('No active session - cannot download artifact');
    }

    if (!this.provider) {
      throw new StagehandError('Provider not initialized - cannot download artifact');
    }

    this.log({
      category: 'artifact',
      message: 'downloading artifact',
      level: 1,
      auxiliary: {
        artifactId: { value: artifactId, type: 'string' },
        sessionId: { value: this.sessionId, type: 'string' },
        providerType: { value: this._providerType, type: 'string' },
      },
    });

    try {
      const data = await this.provider.downloadArtifact(this.sessionId, artifactId);

      this.log({
        category: 'artifact',
        message: 'artifact downloaded successfully',
        level: 1,
        auxiliary: {
          artifactId: { value: artifactId, type: 'string' },
          size: { value: data.length.toString(), type: 'integer' },
        },
      });

      return data;
    } catch (error) {
      this.log({
        category: 'artifact',
        message: 'failed to download artifact',
        level: 0,
        auxiliary: {
          error: { value: (error as Error).message, type: 'string' },
          artifactId: { value: artifactId, type: 'string' },
        },
      });
      throw error;
    }
  }

  /**
   * Save a page screenshot as an artifact
   * @param options - Screenshot options (optional)
   * @returns Artifact information for the saved screenshot
   */
  async saveScreenshot(options?: {
    name?: string;
    type?: 'png' | 'jpeg';
    quality?: number;
    fullPage?: boolean;
  }): Promise<Artifact> {
    if (!this.stagehandPage) {
      throw new StagehandNotInitializedError('page');
    }

    const screenshotOptions = {
      type: options?.type || 'png',
      quality: options?.quality,
      fullPage: options?.fullPage || false,
    };

    this.log({
      category: 'artifact',
      message: 'taking screenshot',
      level: 1,
      auxiliary: {
        type: { value: screenshotOptions.type, type: 'string' },
        fullPage: {
          value: screenshotOptions.fullPage.toString(),
          type: 'boolean',
        },
      },
    });

    try {
      const screenshotBuffer = await this.page.screenshot(screenshotOptions);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = options?.name || `screenshot-${timestamp}.${screenshotOptions.type}`;

      return await this.saveArtifact(fileName, Buffer.from(screenshotBuffer));
    } catch (error) {
      this.log({
        category: 'artifact',
        message: 'failed to save screenshot',
        level: 0,
        auxiliary: {
          error: { value: (error as Error).message, type: 'string' },
        },
      });
      throw error;
    }
  }

  /**
   * Start browser screencast for real-time viewing
   */
  async startScreencast(options?: ScreencastOptions): Promise<void> {
    if (!this.stagehandPage) {
      throw new StagehandNotInitializedError('page');
    }

    if (!this.provider) {
      throw new StagehandNotInitializedError('provider');
    }

    // Check if provider supports screencast
    if (!hasScreencastCapabilities(this.provider)) {
      throw new Error('Current provider does not support screencast functionality');
    }

    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error('No active session for screencast');
    }

    this.log({
      category: 'screencast',
      message: 'starting browser screencast',
      level: 1,
      auxiliary: {
        options: {
          value: JSON.stringify(options || {}),
          type: 'string' as const,
        },
      },
    });

    await this.provider.startScreencast!(sessionId, options);
  }

  /**
   * Stop browser screencast
   */
  async stopScreencast(): Promise<void> {
    if (!this.stagehandPage) {
      throw new StagehandNotInitializedError('page');
    }

    if (!this.provider) {
      throw new StagehandNotInitializedError('provider');
    }

    // Check if provider supports screencast
    if (!hasScreencastCapabilities(this.provider)) {
      throw new Error('Current provider does not support screencast functionality');
    }

    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error('No active session for screencast');
    }

    this.log({
      category: 'screencast',
      message: 'stopping browser screencast',
      level: 1,
    });

    await this.provider.stopScreencast!(sessionId);
  }

  /**
   * Send user input to remote browser (for screencast interaction)
   */
  async sendInput(inputEvent: InputEvent): Promise<void> {
    if (!this.stagehandPage) {
      throw new StagehandNotInitializedError('page');
    }

    if (!this.provider) {
      throw new StagehandNotInitializedError('provider');
    }

    // Check if provider supports input
    if (!hasScreencastCapabilities(this.provider)) {
      throw new Error('Current provider does not support input functionality');
    }

    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error('No active session for input');
    }

    this.log({
      category: 'screencast',
      message: 'sending user input to browser',
      level: 2,
      auxiliary: {
        inputType: {
          value: inputEvent.type,
          type: 'string' as const,
        },
      },
    });

    await this.provider.sendInput!(sessionId, inputEvent);
  }

  /**
   * Add event listener for screencast events
   */
  on(event: 'screencastFrame', listener: (frame: ScreencastFrame) => void): this;
  on(event: 'screencastStarted', listener: (sessionId: string) => void): this;
  on(event: 'screencastStopped', listener: (sessionId: string) => void): this;
  on(event: 'screencastError', listener: (error: Error, sessionId: string) => void): this;
  on(
    event: string,
    listener:
      | ((frame: ScreencastFrame) => void)
      | ((sessionId: string) => void)
      | ((error: Error, sessionId: string) => void)
      | ((...args: unknown[]) => void)
  ): this {
    if (!this.provider) {
      throw new StagehandNotInitializedError('provider');
    }

    // Forward to provider if it supports events
    if (hasScreencastCapabilities(this.provider) && this.provider.on) {
      this.provider.on(event, listener as (...args: unknown[]) => void);
    }

    return this;
  }

  /**
   * Get a list of downloads that occurred during the session
   * @deprecated Use getArtifacts() instead. This method is kept for backwards compatibility.
   */
  async getDownloads(): Promise<Artifact[]> {
    this.log({
      category: 'deprecation',
      message: 'getDownloads() is deprecated. Use getArtifacts() instead.',
      level: 1,
    });

    const artifactList = await this.getArtifacts();
    return artifactList.artifacts;
  }
}

export * from '../types/browser';
export * from '../types/log';
export * from '../types/model';
export * from '../types/page';
export * from '../types/playwright';
export * from '../types/stagehand';
export * from '../types/operator';
export * from '../types/agent';
export * from '../types/provider';
export * from './llm/LLMClient';
export * from '../types/stagehandErrors';
export * from '../types/stagehandApiErrors';
