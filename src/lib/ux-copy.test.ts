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
    expect(kindLabel("stream")).toBeNull();
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

  it("gives each voice a play sample and one quiet Make audiobook control", () => {
    expect(UX.preview).toBe("Preview");
    expect(UX.liveListen).toBe("Preview");
    expect(UX.makeAudiobook).toBe("Make audiobook");
    expect(UX.previewHint.toLowerCase()).toMatch(/not your book|not the book/);
    expect(UX.tryChapterBlurb.toLowerCase()).toMatch(/sample/);
    expect(UX.tryChapterBlurb.toLowerCase()).not.toMatch(/stream the book/);
    expect(UX.preview).not.toMatch(/Live Stream|Live Listen/i);
    expect(UX.makeAudiobook).not.toMatch(/Live Stream|Live Listen/i);
    expect(UX.tryChapter).not.toMatch(/Live Stream|Preview/i);
    expect(UX.seekingUnavailable).toBe("Seeking unavailable");
    expect(UX.seekingUnavailable).not.toMatch(/Live Stream|Live Listen/i);

    const voicePage = sourceOf("src/app/dashboard/voice/page.tsx");
    expect(voicePage).toContain("UX.preview");
    expect(voicePage).toContain("UX.makeAudiobook");
    expect(voicePage).toContain("previewVoice");
    expect(voicePage).toMatch(/selectedVoiceId|selectedVoice/);
    expect(voicePage).toMatch(/createStockJob\(selectedVoice\)/);
    expect(voicePage).not.toMatch(/createStockJob\(voice\)/);
    expect(voicePage).toMatch(/jobKind: ["']takehome["']/);
    expect(voicePage).not.toMatch(/jobKind: ["']stream["']/);
    expect(voicePage).not.toMatch(/createStockJob\(voice, ["']stream["']\)/);
    expect(UX.preparingText).toBe("Preparing text…");
    expect(voicePage).toContain("UX.preparingText");
    expect(voicePage).toContain("waitForUploadExtract");
    expect(voicePage).not.toMatch(/Reading document/);
    expect(voicePage).not.toMatch(/bg-copper|hover:bg-copper/);
    expect(voicePage).not.toMatch(
      /UX\.makeAudiobook[\s\S]{0,200}bg-foreground text-background/
    );
    expect(voicePage).not.toMatch(
      /createStockJob\(selectedVoice\)[\s\S]{0,240}bg-foreground text-background/
    );
    expect(voicePage).not.toMatch(/Est\. €|suggestedPriceEur|priceLabel|generationEta/);
    expect(voicePage).not.toMatch(/about \d+ min|est\. €/i);
    expect(voicePage.match(/UX\.makeAudiobook/g)?.length).toBe(1);
    expect(voicePage).not.toMatch(/\bsetIntent\b|\btype Intent\b/);
    expect(voicePage).not.toMatch(/Live Stream|Live Listen/);
    expect(voicePage).not.toContain("UX.tryChapter");
    expect(voicePage).not.toContain("UX.startListening");
    expect(voicePage).not.toContain("UX.wholeBookShort");
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toContain(
      "UX.preview"
    );
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toContain(
      "UX.makeAudiobook"
    );
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).toMatch(
      /hear a sample|choose a narrator/i
    );
    expect(sourceOf("src/app/dashboard/resources/page.tsx")).not.toMatch(
      /€|about \d+ min|copper/i
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
    expect(LANDING.signInCta).toBe("Sign in");
    expect(LANDING.signInCta).not.toMatch(/Google/i);
    expect(LANDING.uploadTab).toBe("Upload");
    expect(LANDING.pasteTab).toBe("Paste");
    expect(LANDING).not.toHaveProperty("heroSubtitle");
    expect(LANDING).not.toHaveProperty("features");
    const landing = sourceOf("src/components/landing-page.tsx");
    expect(landing).not.toMatch(/EPUB or TXT preferred/);
    expect(landing).not.toMatch(/LANDING\.features/);
    expect(landing).not.toMatch(/LANDING\.heroSubtitle/);
    expect(landing).not.toMatch(/Reading document/);
    expect(landing).not.toMatch(/uploadPhase === ["']reading["']/);
    expect(landing).toMatch(/goToVoice\(data\)/);
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

  it("keeps Sign out inside the signed-in name menu, not as standalone chrome", () => {
    const chrome = sourceOf("src/app/dashboard/chrome.tsx");
    const landing = sourceOf("src/components/landing-page.tsx");
    const auth = sourceOf("src/components/auth-controls.tsx");
    const chromeHeader = chrome.slice(0, chrome.indexOf("</header>"));
    const landingNav = landing.slice(0, landing.indexOf("</nav>"));
    expect(chromeHeader).not.toMatch(/Sign out|signOutCta|NAV\.signOut/);
    expect(landingNav).not.toMatch(/Sign out|signOutCta|NAV\.signOut/);
    expect(landingNav).not.toMatch(/LANDING\.libraryCta/);
    expect(chrome).not.toMatch(/<footer[\s\S]*AuthControls/);
    expect(landing).not.toMatch(/<footer[\s\S]*AuthControls/);
    expect(auth).not.toMatch(/placement/);
    expect(auth).not.toMatch(/Sign in with Google/);
    expect(auth).toContain("NAV.settings");
    expect(auth).toContain("NAV.library");
    expect(auth).toContain("NAV.signOut");
    expect(auth).toContain("DarkModeToggle");
    expect(auth).toContain("AccountMenu");
    expect(sourceOf("src/app/dashboard/player/[id]/page.tsx")).not.toMatch(
      /Sign out|signOutCta/
    );
  });

  it("uses the formal serif wordmark on inner pages and only the center logo on landing", () => {
    const landing = sourceOf("src/components/landing-page.tsx");
    const landingNav = landing.slice(
      landing.indexOf("<nav"),
      landing.indexOf("</nav>")
    );
    const chrome = sourceOf("src/app/dashboard/chrome.tsx");
    expect(landing).toContain('size="hero"');
    expect(landingNav).not.toMatch(/Wordmark|Echomancer/);
    expect(landingNav).not.toMatch(/tracking-\[0\.18em\]|uppercase/);
    expect(chrome).toContain('size="nav"');
    expect(chrome).not.toMatch(/tracking-\[0\.18em\] uppercase/);
    expect(sourceOf("src/components/wordmark.tsx")).toContain("font-serif");
    expect(sourceOf("src/components/wordmark.tsx")).toContain('fontWeight: 300');
  });

  it("keeps the player sparse and on the same muted tokens", () => {
    const player = sourceOf("src/app/dashboard/player/[id]/page.tsx");
    expect(player).not.toMatch(/#D97757|bg-copper|border-\[#D97757\]/);
    expect(player).not.toMatch(/Starting generation/);
    expect(player).not.toMatch(/elapsed_label|eta_label/);
    expect(player).not.toMatch(/SkipBack|SkipForward|Volume2|Clock/);
    expect(player).toContain("Back 10 seconds");
    expect(player).toContain("Forward 10 seconds");
    expect(player).toContain("clampSeekSeconds");
    expect(player).toContain("ThinPause");
    expect(player).not.toMatch(/PLAYBACK_SPEED_PRESETS\.map/);
    expect(player).toContain("nextPlaybackSpeed");
    expect(player).not.toMatch(/rounded-full bg-foreground text-background/);
    expect(player).toContain("UX.preparingAudio");
    expect(player).not.toContain("UX.savedBook");
    expect(player).toMatch(/audioUrl \?/);
    expect(sourceOf("src/lib/player/playback-speed.ts")).toContain(
      "0.8, 0.9, 1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5"
    );
    expect(player).toContain("formatPlaybackSpeed");
    const slider = sourceOf("src/components/ui/slider.tsx");
    expect(slider).toContain("h-0.5");
    expect(slider).toContain("size-5");
    expect(slider).not.toMatch(/data-\[orientation=horizontal\]:h-4/);
    expect(slider).not.toContain("size-6");
  });

  it("does not market Live Stream or Live Listen in customer UI", () => {
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
      "src/app/dashboard/account/page.tsx",
      "src/components/account-settings.tsx",
      "src/components/dark-mode-toggle.tsx",
      "src/components/wordmark.tsx",
      "src/app/dashboard/narration-delivery-controls.tsx",
    ];
    for (const file of surfaces) {
      expect(sourceOf(file), file).not.toMatch(/Live Stream|Live Listen/i);
    }
  });

  it("drops immersion fluff from landing and chrome surfaces", () => {
    const surfaces = [
      "src/components/landing-page.tsx",
      "src/components/auth-controls.tsx",
      "src/app/dashboard/chrome.tsx",
      "src/app/dashboard/voice/page.tsx",
      "src/app/dashboard/queue/page.tsx",
      "src/app/dashboard/resources/page.tsx",
      "src/app/dashboard/account/page.tsx",
      "src/components/account-settings.tsx",
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
      "src/app/dashboard/account/page.tsx",
      "src/components/account-settings.tsx",
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
