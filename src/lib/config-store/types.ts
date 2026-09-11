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
   * The `wsl --version` the verdict above was measured against. A mismatch with
   * the running WSL means the question is open again rather than settled
   * forever. (Earlier builds could write 'manual' here; that matches nothing.)
   */
  RUNTIME_RECLAIM_VERIFIED_WSL?: string;
  /**
   * The `[experimental] autoMemoryReclaim` mode (`gradual` or `dropcache`) the
   * verdict was measured under. Absent or different from the current setting
   * means the verdict is not used.
   */
  RUNTIME_RECLAIM_VERIFIED_MODE?: string;
}
