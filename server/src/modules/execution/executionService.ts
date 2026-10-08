import {
  ExecutionRequest,
  ExecutionResult,
  ExecutionProviderStatus,
  SupportedLanguage,
} from '@synccode/shared';
import { ExecutionProvider } from './executionProvider';
import { PistonExecutionProvider } from './pistonProvider';

export class ExecutionService {
  private provider: ExecutionProvider;
  private lastHealthStatus: ExecutionProviderStatus | null = null;
  private lastHealthCheckTime = 0;

  constructor(provider?: ExecutionProvider) {
    this.provider = provider || new PistonExecutionProvider();
  }

  /**
   * Sets or swaps the active execution provider (useful for testing or alternative sandboxes).
   */
  public setProvider(provider: ExecutionProvider): void {
    this.provider = provider;
    this.lastHealthStatus = null;
    this.lastHealthCheckTime = 0;
  }

  /**
   * Returns the name of the currently active provider.
   */
  public getActiveProviderName(): string {
    return this.provider.name;
  }

  /**
   * Checks the health and availability of the current execution provider.
   * Caches successful result for 30 seconds to avoid unnecessary external pings.
   */
  public async checkHealth(timeoutMs = 2500, force = false): Promise<ExecutionProviderStatus> {
    const now = Date.now();
    if (!force && this.lastHealthStatus && now - this.lastHealthCheckTime < 30000) {
      return this.lastHealthStatus;
    }

    try {
      const status = await this.provider.checkHealth(timeoutMs);
      this.lastHealthStatus = status;
      this.lastHealthCheckTime = now;
      return status;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown health check failure';
      const failedStatus: ExecutionProviderStatus = {
        name: this.provider.name,
        isAvailable: false,
        error: errorMsg,
        supportedLanguages: [],
      };
      this.lastHealthStatus = failedStatus;
      this.lastHealthCheckTime = now;
      return failedStatus;
    }
  }

  /**
   * Executes code using the isolated sandbox provider.
   * Enforces system safety constraints before dispatching to the provider:
   * - Never executes code inside the Node.js server.
   * - Rejects payloads larger than 64KB.
   * - Validates supported languages.
   * - Enforces execution timeouts (1s - 15s).
   */
  public async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const timestamp = Date.now();

    // 1. Code Payload Size Limit (64KB)
    if (!request.code || typeof request.code !== 'string') {
      return {
        executionId: `err-${timestamp}`,
        roomId: request.roomId,
        status: 'ERROR',
        language: request.language,
        stdout: '',
        stderr: 'Code payload cannot be empty',
        exitCode: 1,
        durationMs: 0,
        timestamp,
        provider: this.provider.name,
        error: 'EMPTY_CODE',
      };
    }

    const MAX_CODE_BYTES = 65536; // 64KB
    if (Buffer.byteLength(request.code, 'utf8') > MAX_CODE_BYTES) {
      return {
        executionId: `err-${timestamp}`,
        roomId: request.roomId,
        status: 'ERROR',
        language: request.language,
        stdout: '',
        stderr: `Code payload exceeds maximum size limit of 64KB (${Buffer.byteLength(request.code, 'utf8')} bytes)`,
        exitCode: 1,
        durationMs: 0,
        timestamp,
        provider: this.provider.name,
        error: 'PAYLOAD_TOO_LARGE',
      };
    }

    // 2. Validate Supported Language
    const supported = await this.provider.getSupportedLanguages();
    if (!supported.includes(request.language)) {
      return {
        executionId: `err-${timestamp}`,
        roomId: request.roomId,
        status: 'ERROR',
        language: request.language,
        stdout: '',
        stderr: `Language '${request.language}' is not supported by ${this.provider.name} provider. Supported: ${supported.join(', ')}`,
        exitCode: 1,
        durationMs: 0,
        timestamp,
        provider: this.provider.name,
        error: 'UNSUPPORTED_LANGUAGE',
      };
    }

    // 3. Dispatch to isolated execution sandbox
    return this.provider.execute(request, {
      timeoutMs: request.timeoutMs,
      maxOutputBytes: 65536,
    });
  }

  /**
   * Retrieves supported languages from current provider.
   */
  public async getSupportedLanguages(): Promise<SupportedLanguage[]> {
    return this.provider.getSupportedLanguages();
  }

  /**
   * Non-blocking startup probe.
   * Logs provider status without stalling server boot if external network is unavailable.
   */
  public async initHealthCheck(): Promise<void> {
    try {
      const status = await this.checkHealth(2000, true);
      if (status.isAvailable) {
        console.log(`[ExecutionService] Sandbox provider '${status.name}' is READY (${status.latencyMs}ms latency)`);
      } else {
        console.warn(
          `[ExecutionService] Sandbox provider '${status.name}' is currently UNAVAILABLE: ${status.error}. Code execution will report provider unavailable until connectivity is restored.`
        );
      }
    } catch {
      console.warn(`[ExecutionService] Initial sandbox provider probe did not respond.`);
    }
  }
}

export const executionService = new ExecutionService();
