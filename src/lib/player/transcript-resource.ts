import type { ReadAlongDocument } from "./read-along";

/** Share an in-flight refresh between the transcript panel and audio handoff. */
export function createTranscriptResource(id: string) {
  let cached: { revision: string; document: ReadAlongDocument } | null = null;
  let pending: { revision: string; promise: Promise<ReadAlongDocument> } | null = null;
  return {
    invalidate(revision: string) {
      if (cached?.revision === revision) cached = null;
    },
    load(revision: string): Promise<ReadAlongDocument> {
      if (cached?.revision === revision) return Promise.resolve(cached.document);
      if (pending?.revision === revision) return pending.promise;
      const promise = fetch(`/api/jobs/${id}/transcript`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
        .then(async (response) => {
          if (!response.ok) throw new Error("Transcript unavailable");
          const document = await response.json() as ReadAlongDocument;
          if (pending?.promise === promise) cached = { revision, document };
          return document;
        })
        .finally(() => {
          if (pending?.promise === promise) pending = null;
        });
      pending = { revision, promise };
      return promise;
    },
  };
}

export function transcriptRevision(job: {
  status: string;
  current_section: number;
  total_sections: number;
  duration_seconds: number | null;
  segments?: unknown;
}): string {
  return JSON.stringify([(["ready", "failed", "cancelled"].includes(job.status) ? job.status : "generating"), job.current_section, job.total_sections,
    job.duration_seconds, job.segments]);
}
