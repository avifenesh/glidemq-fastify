import type { Queue, Worker, Job, ConnectionOptions } from 'glide-mq';

// --- Config ---

export interface QueueConfig<D = any, R = any> {
  processor?: (job: Job<D, R>) => Promise<R>;
  concurrency?: number;
  workerOpts?: Record<string, unknown>;
}

export interface GlideMQConfig {
  connection?: ConnectionOptions;
  queues: Record<string, QueueConfig>;
  prefix?: string;
  testing?: boolean;
}

// --- Registry ---

export interface ManagedQueue<D = any, R = any> {
  queue: Queue<D, R>;
  worker: Worker<D, R> | null;
}

export interface QueueRegistry {
  get<D = any, R = any>(name: string): ManagedQueue<D, R>;
  has(name: string): boolean;
  names(): string[];
  closeAll(): Promise<void>;
  readonly testing: boolean;
  getConnection(): ConnectionOptions | undefined;
  getPrefix(): string | undefined;
}

// --- Plugin options ---

export type GlideMQPluginOptions = GlideMQConfig;

export interface GlideMQRoutesOptions {
  queues?: string[];
}

// --- Job serialization ---

export interface JobResponse {
  id: string;
  name: string;
  data: unknown;
  opts: Record<string, unknown>;
  attemptsMade: number;
  returnvalue: unknown;
  failedReason: string | undefined;
  progress: number | object;
  timestamp: number;
  finishedOn: number | undefined;
  processedOn: number | undefined;
}

export interface JobCountsResponse {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}

export interface WorkerInfoResponse {
  id: string;
  addr: string;
  pid: number;
  startedAt: number;
  age: number;
  activeJobs: number;
}

// --- Fastify module augmentation ---

declare module 'fastify' {
  interface FastifyInstance {
    glidemq: QueueRegistry;
  }
}
