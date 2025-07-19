import { Browser, BrowserContext } from './page';
import { ProviderType } from './provider';

export interface BrowserResult {
  provider: ProviderType;
  browser?: Browser;
  context: BrowserContext;
  debugUrl?: string;
  sessionUrl?: string;
  contextPath?: string;
  sessionId?: string;
}
