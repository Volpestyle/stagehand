import { BrowserResult } from '../types/browser';
import { LogLine } from '../types/log';
import { LocalBrowserLaunchOptions } from '../types/stagehand';
import { IBrowserProvider } from '../types/provider';

interface GetBrowserParams {
  provider: IBrowserProvider;
  sessionId?: string;
  headless?: boolean;
  logger: (message: LogLine) => void;

  // Backwards compatibility options (unused but kept for compatibility)
  apiKey?: string;
  projectId?: string;
  env?: 'LOCAL' | 'BROWSERBASE';
  browserbaseSessionCreateParams?: Record<string, unknown>;
  browserbaseSessionID?: string;
  localBrowserLaunchOptions?: LocalBrowserLaunchOptions;
}

/**
 * Provider-based browser connection function
 * Replaces the old getBrowser function with provider abstraction
 */
export async function getBrowserWithProvider(params: GetBrowserParams): Promise<BrowserResult> {
  const {
    provider: browserProvider,
    sessionId,
    // headless = false, // unused for now
    logger,
    // Backwards compatibility
    browserbaseSessionCreateParams,
    browserbaseSessionID,
  } = params;

  logger({
    category: 'browser-connection',
    message: `initializing ${browserProvider.type} provider`,
    level: 1,
    auxiliary: {
      provider: { value: browserProvider.type, type: 'string' },
    },
  });

  try {
    let session;
    const targetSessionId = sessionId || browserbaseSessionID;

    if (targetSessionId) {
      // Resume existing session
      logger({
        category: 'browser-connection',
        message: 'resuming existing session',
        level: 1,
        auxiliary: {
          sessionId: { value: targetSessionId, type: 'string' },
        },
      });
      session = await browserProvider.resumeSession(targetSessionId);
    } else {
      // Create new session
      logger({
        category: 'browser-connection',
        message: 'creating new session',
        level: 1,
      });

      const sessionParams = {
        userMetadata: browserbaseSessionCreateParams,
      };
      session = await browserProvider.createSession(sessionParams);
    }

    // Connect to browser
    logger({
      category: 'browser-connection',
      message: 'connecting to browser instance',
      level: 1,
      auxiliary: {
        sessionId: { value: session.sessionId, type: 'string' },
      },
    });

    const connectionResult = await browserProvider.connectToBrowser(session);

    const result: BrowserResult = {
      provider: browserProvider.type,
      browser: connectionResult.browser,
      context: connectionResult.browser.contexts()[0],
      debugUrl: session.debugUrl,
      sessionUrl: session.sessionUrl,
      contextPath: connectionResult.contextPath,
      sessionId: session.sessionId,
      // Backwards compatibility
      env: browserProvider.type === 'local' ? 'LOCAL' : 'BROWSERBASE',
    };

    logger({
      category: 'browser-connection',
      message: `${browserProvider.type} browser session established`,
      level: 1,
      auxiliary: {
        sessionId: { value: session.sessionId, type: 'string' },
        ...(session.debugUrl && {
          debugUrl: { value: session.debugUrl, type: 'string' },
        }),
        ...(session.sessionUrl && {
          sessionUrl: { value: session.sessionUrl, type: 'string' },
        }),
      },
    });

    return result;
  } catch (error) {
    logger({
      category: 'browser-connection',
      message: 'failed to establish browser connection',
      level: 0,
      auxiliary: {
        error: { value: (error as Error).message, type: 'string' },
        provider: { value: browserProvider.type, type: 'string' },
      },
    });
    throw error;
  }
}
