export type SupportedLanguage = 'javascript' | 'typescript' | 'python' | 'cpp' | 'java';

export interface ExecutionFile {
  name?: string;
  content: string;
}

export interface ExecutionRequest {
  roomId?: string;
  language: SupportedLanguage;
  code: string;
  stdin?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface ExecutionResult {
  executionId: string;
  roomId?: string;
  status: 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'MEMORY_LIMIT' | 'PROVIDER_UNAVAILABLE';
  language: SupportedLanguage;
  version?: string;
  stdout: string;
  stderr: string;
  compileOutput?: string;
  exitCode: number;
  durationMs: number;
  timestamp: number;
  provider: string;
  error?: string;
}

export interface ExecutionProviderStatus {
  name: string;
  isAvailable: boolean;
  latencyMs?: number;
  error?: string;
  supportedLanguages: string[];
  endpoint?: string;
}

export interface RuntimeInfo {
  language: string;
  version: string;
  aliases: string[];
}
