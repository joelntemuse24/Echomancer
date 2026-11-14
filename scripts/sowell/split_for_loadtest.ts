/**
 * Print the sections a Kokoro-CPU book would actually synthesize.
 *
 * A load test is only useful if its requests are shaped like production's.
 * This runs the **production** splitter (`buildFrozenScript` →
 * `packSpeakableSections`) with `packProvider` set to a Kokoro CPU voice, so
 * the section count, the ~700-character target, the short opening ramp, the
 * heading threshold, and the hard max are the ones a book gets.
 *
 *   npx tsx scripts/sowell/split_for_loadtest.ts book.txt drew
 *   npx tsx scripts/sowell/split_for_loadtest.ts book.txt drew 700
 *   KOKORO_CPU_SECTION_CHARS=900 npx tsx scripts/sowell/split_for_loadtest.ts book.txt sowell
 *
 * The voice is one of `drew`, `sowell` (Walter), or `george`. The third
 * position overrides the target for this run; it is clamped exactly like
 * `KOKORO_CPU_SECTION_CHARS` (300..2000).
 *
 * Output is one JSON line, so a driver can read stdout directly:
 *
 *   [{"index":0,"chars":412,"text":"..."}]
 *
 * Pass `--texts-only` for a bare JSON array of strings (same order), which is
 * what most request loops want. Diagnostics go to stderr.
 *
 * Nothing here speaks, fetches, or writes: it reads the file and prints.
 */

import { readFileSync } from "node:fs";

const KOKORO_VOICES = ["drew", "sowell", "george"] as const;

function usage(): never {
  console.error(
    [
      "usage: npx tsx scripts/sowell/split_for_loadtest.ts <book.txt> [voice] [targetChars] [--texts-only]",
      "",
      "  voice        drew | sowell (Walter) | george   (default: drew)",
      "  targetChars  300..2000                        (default: KOKORO_CPU_SECTION_CHARS or 700)",
      "  --texts-only print a JSON array of section strings instead of objects",
    ].join("\n")
  );
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const textsOnly = argv.includes("--texts-only");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const [file, voiceArg, targetArg] = positional;
  if (!file) usage();

  const voice = (voiceArg ?? "drew").toLowerCase();
  if (!(KOKORO_VOICES as readonly string[]).includes(voice)) {
    console.error(`unknown Kokoro-CPU voice: ${voice}`);
    usage();
  }

  if (targetArg != null && targetArg !== "") {
    const parsed = Number(targetArg);
    if (!Number.isFinite(parsed)) {
      console.error(`target must be a number: ${targetArg}`);
      usage();
    }
    // The same clamp `KOKORO_CPU_SECTION_CHARS` uses, applied to this run only.
    process.env.KOKORO_CPU_SECTION_CHARS = String(Math.floor(parsed));
  }

  const rawText = readFileSync(file, "utf8");
  if (!rawText.trim()) {
    console.error(`no text in ${file}`);
    process.exit(1);
  }

  // Dynamic imports so the env this script sets is in place before any module
  // that reads `.env.local` is evaluated (dotenv prints its banner to stdout,
  // and quiet is decided at that moment).
  process.env.DOTENV_CONFIG_QUIET = "true";
  const [{ buildFrozenScript }, sectionSize] = await Promise.all([
    import("@/lib/tts/frozen-script"),
    import("@/lib/tts/section-size"),
  ]);
  const { kokoroCpuSectionPlan, kokoroCpuSectionChars } = sectionSize;

  const plan = kokoroCpuSectionPlan();
  const built = buildFrozenScript({
    rawText,
    maxChars: plan.maxChars,
    hardMaxChars: plan.hardMaxChars,
    packProvider: voice as (typeof KOKORO_VOICES)[number],
  });

  const lengths = built.sections.map((section) => section.text.length);
  console.error(
    `voice=${voice} sections=${built.sections.length} target=${kokoroCpuSectionChars()} ` +
      `chars=${built.speakable.length} first=${lengths[0] ?? 0} max=${Math.max(0, ...lengths)}`
  );
  if (textsOnly) {
    process.stdout.write(JSON.stringify(built.sections.map((section) => section.text)) + "\n");
    return;
  }
  process.stdout.write(
    JSON.stringify(
      built.sections.map((section) => ({
        index: section.index,
        chars: section.text.length,
        text: section.text,
      }))
    ) + "\n"
  );
}

void main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
