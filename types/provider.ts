import { Browser } from '@playwright/test';
import { LogLine } from './log';
import { ScreencastOptions, InputEvent } from '@wallcrawler/infra-common';

/**
 * Supported provider types for browser automation
 */
export type ProviderType = 'local' | 'aws';

/**
 * Session information returned by a provider
 */
export interface ProviderSession {
  /** Unique session identifier */
  sessionId: string;
  /** Connection URL for CDP or similar protocols */
  connectUrl?: string;
  /** Debug URL for session monitoring */
  debugUrl?: string;
  /** Session URL for provider dashboard */
  sessionUrl?: string;
  /** Provider type that created this session */
  provider: ProviderType;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for creating a new session
 */
export interface SessionCreateParams {
  /** Timeout for session creation in milliseconds */
  timeoutMs?: number;
  /** User-defined metadata for the session */
  userMetadata?: Record<string, unknown>;
  /** Provider-specific configuration */
  config?: Record<string, unknown>;
}

/**
 * File artifact information
 */
export interface Artifact {
  /** Unique identifier for the artifact */
  id: string;
  /** Original filename */
  name: string;
  /** File size in bytes */
  size: number;
  /** MIME type of the file */
  mimeType?: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Provider-specific storage path or key */
  path: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * List of artifacts with pagination info
 */
export interface ArtifactList {
  /** Array of artifacts */
  artifacts: Artifact[];
  /** Total count of artifacts */
  totalCount: number;
  /** Whether there are more artifacts to fetch */
  hasMore: boolean;
  /** Cursor for pagination */
  nextCursor?: string;
}

/**
 * Result of browser connection operation
 */
export interface BrowserConnectionResult {
  /** Connected browser instance */
  browser: Browser;
  /** Session information */
  session: ProviderSession;
  /** Local context path (for local provider) */
  contextPath?: string;
}

/**
 * Provider configuration interface
 */
export interface ProviderConfig {
  /** Provider type */
  type: ProviderType;
  /** Provider-specific configuration options */
  options?: Record<string, unknown>;
  /** Logging function */
  logger?: (logLine: LogLine) => void;
}

/**
 * Base browser provider interface
 */
export interface IBrowserProvider {
  /** Provider type identifier */
  readonly type: ProviderType;

  /** Provider display name */
  readonly name: string;

  /**
   * Create a new browser session
   */
  createSession(params?: SessionCreateParams): Promise<ProviderSession>;

  /**
   * Resume an existing session
   */
  resumeSession(sessionId: string): Promise<ProviderSession>;

  /**
   * Connect to a browser instance
   */
  connectToBrowser(session: ProviderSession): Promise<BrowserConnectionResult>;

  /**
   * End a browser session
   */
  endSession(sessionId: string): Promise<void>;

  /**
   * Save an artifact to provider storage
   */
  saveArtifact(sessionId: string, path: string, data: Buffer): Promise<Artifact>;

  /**
   * List artifacts for a session
   */
  getArtifacts(sessionId: string, cursor?: string): Promise<ArtifactList>;

  /**
   * Download a specific artifact
   */
  downloadArtifact(sessionId: string, artifactId: string): Promise<Buffer>;

  /**
   * Clean up provider resources
   */
  cleanup?(): Promise<void>;

  // Optional screencast capabilities
  /**
   * Start browser screencast for a session (optional)
   */
  startScreencast?(sessionId: string, options?: ScreencastOptions): Promise<void>;

  /**
   * Stop browser screencast for a session (optional)
   */
  stopScreencast?(sessionId: string): Promise<void>;

  /**
   * Send user input to remote browser (optional)
   */
  sendInput?(sessionId: string, inputEvent: InputEvent): Promise<void>;

  /**
   * Add event listener for screencast events (optional)
   */
  on?(event: string, listener: (...args: unknown[]) => void): void;
}
