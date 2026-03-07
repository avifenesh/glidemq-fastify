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

  return result;
}

export function serializeJobs(jobs: Job[]): JobResponse[] {
  return jobs.map(serializeJob);
}
