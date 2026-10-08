import {
  ExecutionRequest,
  ExecutionResult,
  ExecutionProviderStatus,
  SupportedLanguage,
} from '@synccode/shared';

export interface ExecutionProviderOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Interface that all sandboxed code execution providers must implement.
 * Arbitrary user code MUST NEVER be executed directly within the host Node.js process.
 */
export interface ExecutionProvider {
  /**
   * Unique name of the execution provider (e.g. 'piston', 'docker', 'mock')
   */
  readonly name: string;

  /**
   * Fast health and availability check with strict timeout.
   * Must not throw uncaught errors or hang if provider is offline.
   */
  checkHealth(timeoutMs?: number): Promise<ExecutionProviderStatus>;

  /**
   * Executes code within the isolated sandbox environment.
   */
  execute(
    request: ExecutionRequest,
    options?: ExecutionProviderOptions
  ): Promise<ExecutionResult>;

  /**
   * Retrieves array of programming languages supported by this provider.
   */
  getSupportedLanguages(): Promise<SupportedLanguage[]>;
}
