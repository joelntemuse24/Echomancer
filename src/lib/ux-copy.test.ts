import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { libraryStatus, kindLabel, LANDING, PRIVACY, UX, VOICE_PATH } from "./ux-copy";

const MARKETING_FLUFF = [
  "A space for immersion",
  "immersion",
  "transcend the page",
  "Books expand minds",
  "Voice carries meaning",
];

function sourceOf(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

function assertNoFluff(text: string, label: string) {
  for (const phrase of MARKETING_FLUFF) {
    expect(text, `${label} must not include “${phrase}”`).not.toMatch(
      new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    );
  }
}

describe("ux-copy", () => {
  it("maps jobs to library mental-model statuses", () => {
    expect(libraryStatus({ status: "ready" }).label).toBe(UX.ready);
    expect(libraryStatus({ status: "failed" }).label).toBe(UX.failed);
    expect(libraryStatus({ status: "queued" }).label).toBe(UX.starting);
    expect(
      libraryStatus({
        status: "processing",
        segments: [{ status: "ready" }],
      }).label
    ).toBe(UX.readyToPlay);
    expect(
      libraryStatus({ status: "ready", job_kind: "stream" }).label
    ).toBe(UX.ready);
    expect(
      libraryStatus({ status: "queued", job_kind: "stream" }).label
    ).toBe(UX.listening);
  });

  it("labels job kinds for customers", () => {
    expect(kindLabel("stream")).toBe(UX.tryChapter);
    expect(kindLabel("takehome")).toBe(UX.savedBook);
  });

  it("frames Standard vs Clone as the first voice-step choice", () => {
    expect(VOICE_PATH.standardTitle).toBe("Standard");
    expect(VOICE_PATH.cloneTitle).toBe("Clone");
    expect(VOICE_PATH.standardTitle).not.toMatch(/classic/i);
    expect(JSON.stringify(VOICE_PATH)).not.toMatch(/fish/i);
    expect(JSON.stringify(VOICE_PATH)).not.toMatch(/classic/i);
    assertNoFluff(Object.values(VOICE_PATH).join("\n"), "VOICE_PATH");

    const voicePage = sourceOf("src/app/dashboard/voice/page.tsx");
    expect(voicePage).toContain("VOICE_PATH");
    expect(voicePage).toContain("parseVoicePath");
    expect(voicePage).toContain("voicesForPath");
    expect(voicePage).not.toMatch(/from ["']@\/lib\/tts\/fish-clone["']|from ["']@\/lib\/turso/);
    expect(sourceOf("src/lib/voice-path.ts")).not.toMatch(
      /from ["']@\/lib\/tts\/fish-clone["']|from ["']@\/lib\/turso/
    );
    expect(voicePage).not.toMatch(/Search narrators/);
    expect(voicePage).not.toMatch(/Classic/);
    expect(voicePage).not.toMatch(/bg-emerald-500/);
    expect(voicePage).not.toMatch(/Four ready-made narrators/);
    expect(voicePage).not.toMatch(/Start with a short voice sample/);
    expect(voicePage).not.toMatch(/Tap name for/);
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toMatch(
      /Standard or Clone/
    );
  });

  it("gives the voice step one copper Preview CTA and a quiet full-book action", () => {
    expect(UX.preview).toBe("Preview");
    expect(UX.startListening).toBe("Preview");
    expect(UX.makeAudiobook).toBe("Make audiobook");
    expect(UX.tryChapter).toBe("Preview");
    expect(UX.liveListen).not.toMatch(/Live Listen/i);
    expect(UX.startListening).not.toMatch(/Live Stream/i);
    expect(UX.tryChapter).not.toMatch(/Live Stream/i);

    const voicePage = sourceOf("src/app/dashboard/voice/page.tsx");
    expect(voicePage).toContain("UX.preview");
    expect(voicePage).toContain("UX.makeAudiobook");
    expect(voicePage).toMatch(/bg-copper|bg-\[#D97757\]/);
    expect(voicePage).not.toMatch(/setIntent|Intent/);
    expect(voicePage).not.toMatch(/Live Stream|Live Listen/);
    expect(voicePage).not.toContain("UX.tryChapter");
    expect(voicePage).not.toContain("UX.startListening");
    expect(voicePage).not.toContain("UX.liveListen");
    expect(voicePage).not.toContain("UX.wholeBookShort");
    expect(voicePage).not.toContain("UX.tryChapterBlurb");
    expect(voicePage).not.toContain("UX.wholeBookBlurb");
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toContain(
      "UX.preview"
    );
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toContain(
      "UX.makeAudiobook"
    );
  });

  it("keeps clone quality errors on Voice and moves the tip to How it works", () => {
    expect(UX.cloneSampleTip.toLowerCase()).toMatch(/dry room/);
    expect(UX.cloneSampleTip.toLowerCase()).toMatch(/clean/);
    expect(UX.cloneSampleTip).not.toMatch(/fish/i);
    expect(sourceOf("src/app/dashboard/voice/page.tsx")).not.toContain(
      "UX.cloneSampleTip"
    );
    expect(sourceOf("src/app/dashboard/voice/page.tsx")).toMatch(
      /isn't good enough to clone well|CLONE_SAMPLE_QUALITY_COPY/
    );
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toContain(
      "UX.cloneSampleTip"
    );
    expect(UX.cloneSampleTip).toMatch(/Cleaning tools won't rescue echo/);
  });

  it("keeps landing copy short and practical", () => {
    expect(LANDING.createCta).toBe("Create audiobook");
    expect(LANDING.libraryCta).toBe("Library");
    expect(LANDING.signInCta).toBe("Sign in with Google");
    expect(LANDING.uploadTab).toBe("Upload");
    expect(LANDING.pasteTab).toBe("Paste");
    expect(LANDING).not.toHaveProperty("heroSubtitle");
    expect(LANDING).not.toHaveProperty("features");
    const landing = sourceOf("src/components/landing-page.tsx");
    expect(landing).not.toMatch(/EPUB or TXT preferred/);
    expect(landing).not.toMatch(/LANDING\.features/);
    expect(landing).not.toMatch(/LANDING\.heroSubtitle/);
    expect(UX.wholeBookBlurb).not.toMatch(/fish/i);
    assertNoFluff(Object.values(LANDING).join("\n"), "LANDING");
  });

  it("puts How it works in a bottom corner, not the top nav", () => {
    const chrome = sourceOf("src/app/dashboard/chrome.tsx");
    const landing = sourceOf("src/components/landing-page.tsx");
    const header = chrome.slice(0, chrome.indexOf("</header>"));
    expect(header).not.toMatch(/How it works/);
    expect(chrome).toMatch(/<footer[\s\S]*How it works|UX\.howItWorks/);
    expect(chrome).toMatch(/<footer/);
    expect(landing).toMatch(/<footer[\s\S]*howItWorks|How it works/);
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toContain(
      "UX.howItWorks"
    );
  });

  it("drops immersion fluff from landing and chrome surfaces", () => {
    const surfaces = [
      "src/components/landing-page.tsx",
      "src/components/auth-controls.tsx",
      "src/app/dashboard/chrome.tsx",
      "src/app/dashboard/voice/page.tsx",
      "src/app/dashboard/queue/page.tsx",
      "src/app/dashboard/resources/page.tsx",
    ];
    for (const file of surfaces) {
      assertNoFluff(sourceOf(file), file);
    }
    expect(sourceOf("src/components/landing-page.tsx")).not.toMatch(/drawably/i);
    expect(sourceOf("package.json")).not.toMatch(/drawably/);
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).not.toMatch(
      /feels clear/i
    );
  });

  it("states only real privacy facts for OAuth consent", () => {
    const text = [
      PRIVACY.site,
      PRIVACY.uploads,
      PRIVACY.clones,
      PRIVACY.auth,
      PRIVACY.storage,
      PRIVACY.selling,
      PRIVACY.contact,
    ].join("\n");
    expect(text).toMatch(/echomancer\.xyz/i);
    expect(text).toMatch(/uploaded books|pasted text/i);
    expect(text).toMatch(/delete/i);
    expect(text).toMatch(/clone/i);
    expect(text).toMatch(/Google/i);
    expect(text).toMatch(/name/i);
    expect(text).toMatch(/email/i);
    expect(text).toMatch(/anonymous|signed cookie/i);
    expect(text).toMatch(/Cloudflare R2/i);
    expect(text).toMatch(/Turso/i);
    expect(text).toMatch(/speech is generated by our text-to-speech provider/i);
    expect(text).not.toMatch(/fish/i);
    expect(text).toMatch(/do not sell/i);
    expect(text).toContain("ntemusejoel@gmail.com");
    assertNoFluff(text, "PRIVACY");
  });

  it("keeps Fish vendor names out of customer-facing copy", () => {
    const vendor = /Fish Audio|\bFish narrator\b|powered by Fish|Fish Audio API/i;
    const surfaces = [
      "src/lib/ux-copy.ts",
      "src/app/layout.tsx",
      "src/app/privacy/page.tsx",
      "src/components/landing-page.tsx",
      "src/components/auth-controls.tsx",
      "src/app/dashboard/chrome.tsx",
      "src/app/dashboard/voice/page.tsx",
      "src/app/dashboard/queue/page.tsx",
      "src/app/dashboard/resources/page.tsx",
      "src/app/dashboard/player/[id]/page.tsx",
    ];
    for (const file of surfaces) {
      expect(sourceOf(file), file).not.toMatch(vendor);
    }
    expect(sourceOf("src/app/layout.tsx")).not.toMatch(/Fish Audio turns/i);
    expect(sourceOf("src/app/dashboard/voice/page.tsx")).not.toMatch(
      /No Fish narrators/i
    );
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).not.toMatch(
      /Fish Audio only/i
    );
  });

  it("publishes /privacy and links it from the landing footer", () => {
    const page = sourceOf("src/app/privacy/page.tsx");
    expect(page).toContain("PRIVACY");
    expect(sourceOf("src/components/landing-page.tsx")).toMatch(
      /href=["']\/privacy["']/
    );
    assertNoFluff(page, "src/app/privacy/page.tsx");
  });
});
