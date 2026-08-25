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
}
