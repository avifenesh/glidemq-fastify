import type { Job } from 'glide-mq';
import type { JobResponse } from './types';

export function serializeJob(job: Job): JobResponse {
  const result: JobResponse = {
    id: job.id,
    name: job.name,
    data: job.data,
    opts: job.opts as Record<string, unknown>,
    attemptsMade: job.attemptsMade,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    progress: job.progress,
    timestamp: job.timestamp,
    finishedOn: job.finishedOn,
    processedOn: job.processedOn,
  };

  if ((job as any).parentId != null) result.parentId = (job as any).parentId;
  if ((job as any).parentQueue != null) result.parentQueue = (job as any).parentQueue;
  if ((job as any).orderingKey != null) result.orderingKey = (job as any).orderingKey;
  if ((job as any).cost != null) result.cost = (job as any).cost;
  if ((job as any).schedulerName != null) result.schedulerName = (job as any).schedulerName;
  if ((job as any).usage) result.usage = (job as any).usage;
  if ((job as any).signals?.length) result.signals = (job as any).signals;
  if ((job as any).budgetKey) result.budgetKey = (job as any).budgetKey;
  if ((job as any).fallbackIndex) result.fallbackIndex = (job as any).fallbackIndex;
  if ((job as any).tpmTokens != null) result.tpmTokens = (job as any).tpmTokens;

  return result;
}

export function serializeJobs(jobs: Job[]): JobResponse[] {
  return jobs.map(serializeJob);
}
