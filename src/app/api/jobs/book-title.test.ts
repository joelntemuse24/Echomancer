/**
 * A file name is not a title. The upload intake hands the file name to the
 * voice step, that name becomes `jobs.book_title`, and the library, player,
 * download, and Media Session all read it back. These tests pin the readable
 * form at those boundaries, and that a title the person typed is untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_A, buildRequest, resetDatabase, seedJob, seedUpload } from "@/test/harness";
import { GET as getJobs, POST as createJob } from "@/app/api/jobs/route";
import { GET as getJob, PATCH as patchJob } from "@/app/api/jobs/[id]/route";

const BOOK = "The lamps were lit along the quay. ".repeat(40);
const UPLOAD = "33333333-3333-4333-8333-333333333333";

const DREW_ENV = {
  DREW_ENABLED: "1",
  DREW_URL: "https://example.modal.run",
  DREW_TOKEN: "token",
} as const;

function clearDrewEnv() {
  delete process.env.DREW_ENABLED;
  delete process.env.DREW_URL;
  delete process.env.DREW_TOKEN;
}

beforeEach(async () => {
  await resetDatabase();
  clearDrewEnv();
});

afterEach(() => {
  clearDrewEnv();
});

describe("a file name stored as a book title", () => {
  it("is cleaned when the job is created from a document upload", async () => {
    Object.assign(process.env, DREW_ENV);
    const storagePath = await seedUpload({
      id: UPLOAD,
      userId: USER_A,
      text: BOOK,
    });
    const response = await createJob(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: storagePath,
          // The raw file name, exactly what the voice step used to send.
          bookTitle: "the_hobbit_-_tolkien.pdf",
          catalogVoiceId: "drew",
        },
      })
    );
    expect(response.status).toBe(200);
    const { jobRow } = await import("@/test/harness");
    const row = await jobRow((await response.json()).jobId);
    expect(row?.book_title).toBe("The Hobbit - Tolkien");
  });

  it("keeps a title the person typed", async () => {
    const storagePath = await seedUpload({
      id: UPLOAD,
      userId: USER_A,
      text: BOOK,
    });
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO jobs (id, user_id, book_title, pdf_storage_path, status, job_kind, tts_provider)
       VALUES (?, ?, ?, ?, 'ready', 'takehome', 'drew')`,
      ["job-typed", USER_A, "my own title", storagePath]
    );

    const response = await getJob(
      await buildRequest("/api/jobs/job-typed", { userId: USER_A }),
      { params: Promise.resolve({ id: "job-typed" }) }
    );
    const body = await response.json();
    expect(body.job.book_title).toBe("my own title");
  });

  it("repairs an older row that still holds a file name, without a write", async () => {
    const storagePath = await seedUpload({
      id: UPLOAD,
      userId: USER_A,
      text: BOOK,
    });
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO jobs (id, user_id, book_title, pdf_storage_path, status, job_kind, tts_provider)
       VALUES (?, ?, ?, ?, 'ready', 'takehome', 'drew')`,
      ["job-old", USER_A, "the_hobbit_-_tolkien.pdf", storagePath]
    );

    const detail = await getJob(
      await buildRequest("/api/jobs/job-old", { userId: USER_A }),
      { params: Promise.resolve({ id: "job-old" }) }
    );
    expect((await detail.json()).job.book_title).toBe("The Hobbit - Tolkien");

    const list = await getJobs(
      await buildRequest("/api/jobs", { userId: USER_A })
    );
    const listed = (await list.json()) as {
      jobs: { id: string; book_title: string }[];
    };
    expect(listed.jobs.find((job) => job.id === "job-old")?.book_title).toBe(
      "The Hobbit - Tolkien"
    );
  });

  it("cleans a rename that sends a raw file name, and trims a typed one", async () => {
    await seedJob({
      id: "job-rename",
      userId: USER_A,
      pdfStoragePath: `pdfs/${UPLOAD}/content.txt`,
      status: "ready",
    });

    const fileNamed = await patchJob(
      await buildRequest("/api/jobs/job-rename", {
        method: "PATCH",
        userId: USER_A,
        body: { action: "rename", bookTitle: "pride_and_prejudice.epub" },
      }),
      { params: Promise.resolve({ id: "job-rename" }) }
    );
    expect((await fileNamed.json()).bookTitle).toBe("Pride and Prejudice");

    const typed = await patchJob(
      await buildRequest("/api/jobs/job-rename", {
        method: "PATCH",
        userId: USER_A,
        body: { action: "rename", bookTitle: "  My   own   title " },
      }),
      { params: Promise.resolve({ id: "job-rename" }) }
    );
    expect((await typed.json()).bookTitle).toBe("My own title");
  });
});
