export interface Credentials {
  apiKey: string;
  email: string;
  createdAt: string;
}

export interface WorkerConfig {
  workerId: string;
  tenantId: string;
  tenantName: string;
  orchestratorUrl: string;
}

export interface AppConfig {
  WORKER_NAME?: string;
  /** Memory (MB) to allocate to the container runtime. Stored as a decimal string. */
  RUNTIME_MEMORY_MB?: string;
  /**
   * Whether memory reclaim was *measured* to return memory to the host on this
   * machine. Configuration only says the setting was requested; on some builds
   * it is accepted and does nothing, so sizing trusts this and not the file.
   */
  RUNTIME_RECLAIM_VERIFIED?: 'yes' | 'no';
  /**
   * The `wsl --version` the verdict above was measured against, or 'manual'
   * when a user recorded it themselves. A mismatch with the running WSL means
   * the question is open again rather than settled forever.
   */
  RUNTIME_RECLAIM_VERIFIED_WSL?: string;
}
