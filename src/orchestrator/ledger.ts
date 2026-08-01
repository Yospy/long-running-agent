export type JobStatus = "running" | "done" | "error";

export interface JobRecord {
  status: JobStatus;
  lastHeartbeatAt: number;
}

/** Job map + heartbeat tracking, primarily for observability — enforcement is layered timeouts elsewhere. */
export class HeartbeatLedger {
  private readonly jobs = new Map<string, JobRecord>();

  register(jobId: string): void {
    this.jobs.set(jobId, { status: "running", lastHeartbeatAt: Date.now() });
  }

  heartbeat(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) job.lastHeartbeatAt = Date.now();
  }

  complete(jobId: string, status: Exclude<JobStatus, "running">): void {
    const job = this.jobs.get(jobId);
    if (job) job.status = status;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  snapshot(): ReadonlyMap<string, JobRecord> {
    return this.jobs;
  }
}
