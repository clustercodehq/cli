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
}
