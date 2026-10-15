import { create } from 'zustand';
import type { JobInfo } from '@shared/recording-types';

interface JobsState {
  jobs: Record<string, JobInfo>;
  upsert(job: JobInfo): void;
  setAll(jobs: JobInfo[]): void;
  remove(id: string): void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: {},
  upsert: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  setAll: (jobs) => set({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) }),
  remove: (id) =>
    set((s) => {
      const next = { ...s.jobs };
      delete next[id];
      return { jobs: next };
    }),
}));

export function isActive(job: JobInfo): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** Most recent job for a recording (active first). */
export function jobForRecording(jobs: Record<string, JobInfo>, recordingId: string, kind?: JobInfo['kind']): JobInfo | undefined {
  return Object.values(jobs)
    .filter((j) => j.recordingId === recordingId && (!kind || j.kind === kind))
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.createdAt - a.createdAt)[0];
}
