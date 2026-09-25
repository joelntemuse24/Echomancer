import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { isMarkupOperator } from "@/lib/operator/tools";
import { queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  loadStoredFishMarkup,
  toPublicFishMarkup,
  type OwnedMarkupJob,
} from "@/lib/tts/fish-markup";

export const dynamic = "force-dynamic";

export const metadata = {
  robots: { index: false, follow: false },
  title: "Markup",
};

/**
 * Operator page for the frozen speakable and the exact Fish request text.
 * 404 unless the master switch is on and the session is allowlisted.
 * An allowlisted operator can open any job. The page shows the book, not
 * the owner's email, name, or user id.
 */
export default async function FishMarkupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { id } = await params;
  const { section: sectionQuery } = await searchParams;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!(await isMarkupOperator(session?.userId))) notFound();

  await ensureTtsJobColumns();
  const job = await queryOne<
    OwnedMarkupJob & {
      book_title: string | null;
      voice_name: string | null;
      created_at: number | null;
      updated_at: number | null;
    }
  >(
    `SELECT id, tts_provider, tts_options, book_title, voice_name, created_at, updated_at
     FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  if (!job) notFound();

  const loaded = await loadStoredFishMarkup(job);
  const markup = loaded ? toPublicFishMarkup(loaded, job) : null;
  const sectionIndex =
    sectionQuery != null && /^\d+$/.test(sectionQuery)
      ? Number(sectionQuery)
      : null;
  const sections =
    markup && sectionIndex != null
      ? markup.sections.filter((section) => section.index === sectionIndex)
      : markup?.sections;

  return (
    <div className="max-w-3xl mx-auto px-4 pt-6 pb-16">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <Link
          href={`/dashboard/player/${id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Player
        </Link>
        {markup ? (
          <a
            href={
              sectionIndex != null
                ? `/api/jobs/${id}/markup?section=${sectionIndex}&format=text`
                : `/api/jobs/${id}/markup?format=text`
            }
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Raw text
          </a>
        ) : null}
      </div>

      <h1 className="text-sm font-medium">
        {markup?.title || job.book_title || "Markup"}
      </h1>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {[markup?.voice, markup?.jobId].filter(Boolean).join(" · ")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {markup?.fishBound
          ? "Each block is the exact text field sent to Fish for that section."
          : `Frozen cue-tagged speakable. Provider is ${markup?.provider || "unset"}.`}
      </p>

      {!markup ? (
        <p className="mt-8 text-sm text-muted-foreground">
          This job has no frozen speakable yet. Whole book writes it on the first claim.
        </p>
      ) : null}

      {markup && sectionIndex != null && sections?.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Section {sectionIndex} is not in the frozen pack.
        </p>
      ) : null}

      {markup && markup.sections.length > 1 ? (
        <nav className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <Link href={`/dashboard/player/${id}/markup`} className="hover:text-foreground">
            All
          </Link>
          {markup.sections.map((section) => (
            <Link
              key={section.index}
              href={`/dashboard/player/${id}/markup?section=${section.index}`}
              className="hover:text-foreground font-mono"
            >
              {String(section.index).padStart(2, "0")}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="mt-6 space-y-8">
        {(sections || []).map((section) => {
          const fishText = section.fishText;
          const primary = fishText ?? section.storedText;
          const showStored = fishText != null && fishText !== section.storedText;
          return (
            <section key={section.index} id={`section-${section.index}`}>
              <h2 className="text-[11px] font-mono text-muted-foreground">
                Section {section.index}
                {section.chapterTitle ? ` · ${section.chapterTitle}` : ""}
              </h2>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {primary}
              </pre>
              {showStored ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">
                    Frozen section text
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                    {section.storedText}
                  </pre>
                </details>
              ) : null}
            </section>
          );
        })}
      </div>

      {markup && sectionIndex == null ? (
        <details className="mt-10">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            Full frozen speakable ({markup.speakableSource})
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
            {markup.speakable}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
