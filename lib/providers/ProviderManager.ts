import { IBrowserProvider } from "../../types/provider";
import { LogLine } from "../../types/log";

/**
 * Registry for external browser providers
 * Manages provider instances that are created and configured externally
 */
export class ProviderManager {
  private static providers: Map<string, IBrowserProvider> = new Map();
  private static defaultLogger: (logLine: LogLine) => void = () => {};

  /**
   * Set the default logger for all providers
   */
  static setDefaultLogger(logger: (logLine: LogLine) => void): void {
    ProviderManager.defaultLogger = logger;
  }

  /**
   * Register a provider instance
   */
  static registerProvider(key: string, provider: IBrowserProvider): void {
    ProviderManager.providers.set(key, provider);
  }

  /**
   * Get a registered provider by key
   */
  static getProvider(key: string): IBrowserProvider | undefined {
    return ProviderManager.providers.get(key);
  }

  /**
   * Remove a provider from the registry
   */
  static removeProvider(key: string): void {
    const provider = ProviderManager.providers.get(key);

    if (provider && provider.cleanup) {
      provider.cleanup().catch((err) => {
        ProviderManager.defaultLogger({
          category: "provider-manager",
          message: `Error during provider cleanup: ${err.message}`,
          level: 0,
        });
      });
    }

    ProviderManager.providers.delete(key);
  }

  /**
   * List all registered provider keys
   */
  static getRegisteredProviders(): string[] {
    return Array.from(ProviderManager.providers.keys());
  }

  /**
   * Clean up all providers
   */
  static async cleanup(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    for (const provider of ProviderManager.providers.values()) {
      if (provider.cleanup) {
        cleanupPromises.push(
          provider.cleanup().catch((err) => {
            ProviderManager.defaultLogger({
              category: "provider-manager",
              message: `Error during provider cleanup: ${err.message}`,
              level: 0,
            });
          }),
        );
      }
    }

    await Promise.all(cleanupPromises);
    ProviderManager.providers.clear();
  }
}
