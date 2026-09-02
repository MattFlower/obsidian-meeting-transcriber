import { describe, expect, it } from "vitest";
import {
  appendToTranscriptSection,
  applySummary,
  applySummaryToBody,
  emitFrontmatter,
  extractTranscriptSection,
  formatLocalDate,
  formatLocalTime,
  insertSummarySection,
  mergeSummaryIntoFrontmatter,
  noteFileName,
  parseFrontmatter,
  replaceTranscriptSection,
  sanitizeFileName,
  splitFrontmatter,
  transcriptionNoteContent,
} from "../src/note";

const sampleNote = transcriptionNoteContent({
  title: "2026-08-18 team sync",
  date: "2026-08-18 1430",
  audioLink: "[[audio/team-sync.mp3]]",
  transcript: "Alice: Let's ship it.\nBob: Agreed.",
  tags: ["meeting", "team-sync"],
});

describe("transcriptionNoteContent", () => {
  it("emits frontmatter with tags, description, source and date", () => {
    const parsed = parseFrontmatter(sampleNote);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data.tags).toEqual(["meeting", "team-sync"]);
    expect(parsed.data.description).toBe("");
    expect(parsed.data.source).toBe("[[audio/team-sync.mp3]]");
    expect(parsed.data.date).toBe("2026-08-18 1430");
  });

  it("contains the title and transcript sections", () => {
    expect(sampleNote).toContain("# 2026-08-18 team sync");
    expect(sampleNote).toContain("## Transcript");
    expect(sampleNote).toContain("Alice: Let's ship it.");
  });
});

describe("parseFrontmatter / emitFrontmatter round-trip", () => {
  it("round-trips the known field set", () => {
    const parsed = parseFrontmatter(sampleNote);
    const emitted = emitFrontmatter(parsed.data);
    const reparsed = parseFrontmatter(emitted);
    expect(reparsed.data).toEqual(parsed.data);
  });

  it("parses flow-style tag lists", () => {
    const md = "---\ntags: [a, b]\ndescription: \"x\"\n---\nbody";
    const parsed = parseFrontmatter(md);
    expect(parsed.data.tags).toEqual(["a", "b"]);
    expect(parsed.data.description).toBe("x");
  });

  it("reports no frontmatter when absent", () => {
    const parsed = parseFrontmatter("# Just a note\n\nbody");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe("# Just a note\n\nbody");
  });
});

describe("applySummary", () => {
  it("merges tags without clobbering existing ones", () => {
    const out = applySummary(sampleNote, {
      summary: "We agreed to ship.",
      description: "Planning sync about the release.",
      tags: ["team-sync", "release", "shipping"],
    });
    const parsed = parseFrontmatter(out);
    expect(parsed.data.tags).toEqual([
      "meeting",
      "team-sync",
      "release",
      "shipping",
    ]);
  });

  it("sets the description", () => {
    const out = applySummary(sampleNote, {
      summary: "S",
      description: "A searchable one-liner.",
      tags: [],
    });
    expect(parseFrontmatter(out).data.description).toBe(
      "A searchable one-liner.",
    );
  });

  it("inserts the Summary section before the Transcript section", () => {
    const out = applySummary(sampleNote, {
      summary: "The summary text.",
      description: "d",
      tags: ["x"],
    });
    const summaryIdx = out.indexOf("## Summary");
    const transcriptIdx = out.indexOf("## Transcript");
    expect(summaryIdx).not.toBe(-1);
    expect(transcriptIdx).not.toBe(-1);
    expect(summaryIdx).toBeLessThan(transcriptIdx);
    expect(out).toContain("The summary text.");
  });

  it("replaces an existing Summary section instead of duplicating", () => {
    const once = applySummary(sampleNote, {
      summary: "First summary.",
      description: "d",
      tags: ["x"],
    });
    const twice = applySummary(once, {
      summary: "Second summary.",
      description: "d2",
      tags: ["y"],
    });
    expect(twice.match(/## Summary/g)).toHaveLength(1);
    expect(twice).toContain("Second summary.");
    expect(twice).not.toContain("First summary.");
    // tags accumulate across runs
    expect(parseFrontmatter(twice).data.tags).toEqual(["meeting", "team-sync", "x", "y"]);
  });

  it("works on notes without frontmatter", () => {
    const md = "# Old note\n\n## Transcript\n\ntext";
    const out = applySummary(md, {
      summary: "S",
      description: "D",
      tags: ["t"],
    });
    const parsed = parseFrontmatter(out);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data.tags).toEqual(["t"]);
    expect(out).toContain("## Summary");
    expect(out).toContain("text");
  });
});

describe("splitFrontmatter / applySummaryToBody", () => {
  it("preserves the original frontmatter bytes while inserting Summary", () => {
    // A note with a custom, plugin-unmanaged frontmatter field.
    const md =
      "---\n" +
      "tags: [meeting]\n" +
      "custom: keep-me\n" +
      "---\n\n" +
      "# Title\n\n" +
      "## Transcript\n\n" +
      "words\n";
    const out = applySummaryToBody(md, "The summary.");
    // The raw frontmatter (including the unmanaged field) is untouched.
    expect(out.startsWith("---\ntags: [meeting]\ncustom: keep-me\n---\n\n")).toBe(
      true,
    );
    // Summary is inserted before Transcript.
    const summaryIdx = out.indexOf("## Summary");
    const transcriptIdx = out.indexOf("## Transcript");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeLessThan(transcriptIdx);
    expect(out).toContain("The summary.");
    // The transcript content is preserved.
    expect(out).toContain("words");
  });

  it("replaces an existing Summary section without duplicating it", () => {
    const once = applySummaryToBody(sampleNote, "First.");
    const twice = applySummaryToBody(once, "Second.");
    expect(twice.match(/## Summary/g)).toHaveLength(1);
    expect(twice).toContain("Second.");
    expect(twice).not.toContain("First.");
  });

  it("handles a note with no frontmatter", () => {
    const out = applySummaryToBody("# T\n\n## Transcript\n\nx\n", "S");
    expect(out).toContain("## Summary");
    expect(out).toContain("S");
    expect(out).toContain("x");
  });

  it("places Summary as the first section, after the H1 and before Transcript", () => {
    const md =
      "---\n" +
      "tags: [meeting]\n" +
      'description: ""\n' +
      "---\n\n" +
      "# 2026-08-24 planning\n\n" +
      "## Transcript\n\nAlice: hi\n\n" +
      "## Action items\n\n- do thing\n";
    const out = applySummaryToBody(md, "The recap.");
    const firstSection = out.split("\n").find((l) => l.startsWith("## "));
    expect(firstSection).toBe("## Summary");
    const titleIdx = out.indexOf("# 2026-08-24 planning");
    const summaryIdx = out.indexOf("## Summary");
    const transcriptIdx = out.indexOf("## Transcript");
    expect(titleIdx).toBeLessThan(summaryIdx);
    expect(summaryIdx).toBeLessThan(transcriptIdx);
    expect(out).toContain("The recap.");
    // the existing trailing section is preserved
    expect(out).toContain("## Action items");
  });

  it("splitFrontmatter returns empty prefix when there is no frontmatter", () => {
    const { prefix, body } = splitFrontmatter("# T\n\nbody");
    expect(prefix).toBe("");
    expect(body).toBe("# T\n\nbody");
  });
});

describe("mergeSummaryIntoFrontmatter", () => {
  it("merges tags (union, existing preserved) and sets description", () => {
    const fm: Record<string, unknown> = { tags: ["meeting", "team-sync"], source: "x" };
    mergeSummaryIntoFrontmatter(fm, {
      summary: "s",
      description: "A one-liner.",
      tags: ["team-sync", "release"],
    });
    expect(fm.tags).toEqual(["meeting", "team-sync", "release"]);
    expect(fm.description).toBe("A one-liner.");
    // Unmanaged fields are left intact.
    expect(fm.source).toBe("x");
  });

  it("handles a missing tags field", () => {
    const fm: Record<string, unknown> = {};
    mergeSummaryIntoFrontmatter(fm, { summary: "s", description: "d", tags: ["a"] });
    expect(fm.tags).toEqual(["a"]);
    expect(fm.description).toBe("d");
  });

  it("is case-insensitive when de-duplicating tags", () => {
    const fm: Record<string, unknown> = { tags: ["Meeting"] };
    mergeSummaryIntoFrontmatter(fm, { summary: "s", description: "", tags: ["meeting"] });
    expect(fm.tags).toEqual(["Meeting"]);
  });
});

describe("insertSummarySection", () => {
  it("inserts at the top after the H1 when no Transcript heading exists", () => {
    const out = insertSummarySection("# T\n\nbody", "S");
    const firstSection = out.split("\n").find((l) => l.startsWith("## "));
    expect(firstSection).toBe("## Summary");
    expect(out).toContain("S");
    expect(out).toContain("body");
  });

  it("inserts at the very start when there is no H1", () => {
    const out = insertSummarySection("## Transcript\n\nx\n", "S");
    const firstSection = out.split("\n").find((l) => l.startsWith("## "));
    expect(firstSection).toBe("## Summary");
    expect(out).toContain("x");
  });
});

describe("appendToTranscriptSection", () => {
  it("appends a new paragraph at the end of the Transcript section", () => {
    const out = appendToTranscriptSection(sampleNote, "Carol: Next item.");
    expect(out).toContain("Alice: Let's ship it.");
    expect(out).toContain("Bob: Agreed.");
    expect(out).toContain("Carol: Next item.");
    // The appended text comes after the existing transcript text.
    expect(out.indexOf("Carol: Next item.")).toBeGreaterThan(
      out.indexOf("Bob: Agreed."),
    );
    // Frontmatter and title are untouched.
    expect(parseFrontmatter(out).data.source).toBe("[[audio/team-sync.mp3]]");
    expect(out).toContain("# 2026-08-18 team sync");
  });

  it("preserves a following ## section", () => {
    const md =
      "# T\n\n## Transcript\n\nfirst\n\n## Action items\n\n- do thing\n";
    const out = appendToTranscriptSection(md, "second");
    expect(out).toContain("## Action items");
    expect(out).toContain("- do thing");
    // The new paragraph lands inside the Transcript section, before the
    // next heading.
    expect(out.indexOf("second")).toBeLessThan(
      out.indexOf("## Action items"),
    );
    expect(out.indexOf("second")).toBeGreaterThan(
      out.indexOf("## Transcript"),
    );
  });

  it("creates the Transcript section when it is absent", () => {
    const out = appendToTranscriptSection("# T\n\nbody", "hello");
    expect(out).toContain("## Transcript");
    expect(out).toContain("hello");
    expect(out.indexOf("## Transcript")).toBeGreaterThan(out.indexOf("body"));
    expect(out.trimEnd().endsWith("hello")).toBe(true);
  });

  it("starts an empty Transcript section without extra blank lines", () => {
    const empty = transcriptionNoteContent({
      title: "2026-08-18 live",
      date: "2026-08-18 0900",
      audioLink: "live-microphone",
      transcript: "",
      tags: ["meeting"],
    });
    const out = appendToTranscriptSection(empty, "first words");
    expect(out).toContain("## Transcript\n\nfirst words\n");
  });

  it("does not pile up blank lines across repeated appends", () => {
    let md = transcriptionNoteContent({
      title: "2026-08-18 live",
      date: "2026-08-18 0900",
      audioLink: "live-microphone",
      transcript: "",
      tags: ["meeting"],
    });
    md = appendToTranscriptSection(md, "chunk one");
    const once = md;
    md = appendToTranscriptSection(md, "chunk two");
    md = appendToTranscriptSection(md, "chunk three");
    expect(md).toContain("chunk one\n\nchunk two\n\nchunk three");
    // Exactly one blank line between paragraphs, no pileup.
    const section = md.split("## Transcript")[1];
    expect(section.match(/\n\n\n/g) ?? []).toHaveLength(0);
    // Re-appending the same note state is stable in shape.
    expect(appendToTranscriptSection(once, "chunk two")).toBe(
      appendToTranscriptSection(once, "chunk two"),
    );
  });

  it("trims the appended text and ignores empty input", () => {
    const md = "# T\n\n## Transcript\n\nfirst\n";
    const out = appendToTranscriptSection(md, "  \n  padded text  \n");
    expect(out).toContain("padded text");
    expect(out).not.toContain("  padded");
    expect(appendToTranscriptSection(md, "   ")).toBe(md);
    expect(appendToTranscriptSection(md, "")).toBe(md);
  });
});

describe("sanitizeFileName", () => {
  it("replaces filesystem-unsafe characters", () => {
    expect(sanitizeFileName('a/b:c*d?"e<f>g|h\\i#j^k[l]m')).toBe(
      "a-b-c-d-e-f-g-h-i-j-k-l-m",
    );
  });

  it("collapses whitespace and dashes (spaces are filesystem-safe)", () => {
    expect(sanitizeFileName("  a   b -- c  ")).toBe("a b - c");
  });

  it("falls back to 'untitled' for empty results", () => {
    expect(sanitizeFileName("///")).toBe("untitled");
    expect(sanitizeFileName("")).toBe("untitled");
  });
});

describe("noteFileName", () => {
  it("formats as YYYY-MM-DD HHmm <name>.md", () => {
    const date = new Date(2026, 7, 18, 14, 5);
    expect(noteFileName(date, "team sync")).toBe(
      "2026-08-18 1405 team sync.md",
    );
  });

  it("sanitizes the base name", () => {
    const date = new Date(2026, 0, 2, 9, 7);
    expect(noteFileName(date, 'a/b:c')).toBe("2026-01-02 0907 a-b-c.md");
  });
});

describe("local time formatters", () => {
  it("formatLocalDate / formatLocalTime use zero-padded local components", () => {
    const date = new Date(2026, 8, 1, 21, 30);
    expect(formatLocalDate(date)).toBe("2026-09-01");
    expect(formatLocalTime(date)).toBe("21:30");
    expect(formatLocalTime(date, "")).toBe("2130");
  });

  it("file name, title date, and frontmatter date agree on the day near midnight", () => {
    // Local 23:59 is already the next day in UTC for anyone west of Greenwich;
    // all three stamps come from the same local-time formatters.
    const date = new Date(2026, 8, 1, 23, 59);
    const fileName = noteFileName(date, "late meeting");
    expect(fileName).toBe("2026-09-01 2359 late meeting.md");
    expect(fileName.startsWith(formatLocalDate(date))).toBe(true);
    expect(`${formatLocalDate(date)} ${formatLocalTime(date)}`).toBe(
      "2026-09-01 23:59",
    );
  });
});

describe("extractTranscriptSection", () => {
  it("returns null when there is no Transcript heading", () => {
    expect(extractTranscriptSection("# T\n\nbody\n")).toBeNull();
  });

  it("returns an empty string for an empty section", () => {
    expect(extractTranscriptSection("# T\n\n## Transcript\n\n\n")).toBe("");
  });

  it("returns the trimmed body up to the next heading", () => {
    const md =
      "---\ntitle: x\n---\n\n# T\n\n## Transcript\n\nfirst\n\nsecond\n\n" +
      "## Action items\n- a\n";
    expect(extractTranscriptSection(md)).toBe("first\n\nsecond");
  });
});

describe("replaceTranscriptSection", () => {
  const md =
    "---\ntags:\n  - meeting\n---\n\n# T\n\n## Summary\n\nS\n\n" +
    "## Transcript\n\nraw one\n\nraw two\n\n## Action items\n- a\n";

  it("replaces only the transcript body, keeping frontmatter, title and other sections", () => {
    expect(replaceTranscriptSection(md, "Clean one.\n\nClean two.")).toBe(
      "---\ntags:\n  - meeting\n---\n\n# T\n\n## Summary\n\nS\n\n" +
        "## Transcript\n\nClean one.\n\nClean two.\n\n## Action items\n- a\n",
    );
  });

  it("keeps a single trailing newline when Transcript is the last section", () => {
    expect(
      replaceTranscriptSection("# T\n\n## Transcript\n\nraw\n", "Clean."),
    ).toBe("# T\n\n## Transcript\n\nClean.\n");
  });

  it("normalizes blank-line pileup around the new body", () => {
    expect(
      replaceTranscriptSection(
        "## Transcript\n\n\n\nraw\n\n\n\n## Next\nx\n",
        "Clean.",
      ),
    ).toBe("## Transcript\n\nClean.\n\n## Next\nx\n");
  });

  it("returns the note unchanged without a Transcript heading or with blank text", () => {
    expect(replaceTranscriptSection("# T\n\nbody\n", "Clean.")).toBe(
      "# T\n\nbody\n",
    );
    expect(replaceTranscriptSection(md, "   ")).toBe(md);
  });

  it("round-trips through extractTranscriptSection", () => {
    const out = replaceTranscriptSection(md, "Clean.");
    expect(extractTranscriptSection(out)).toBe("Clean.");
    expect(extractTranscriptSection(sampleNote)).toBe(
      "Alice: Let's ship it.\nBob: Agreed.",
    );
  });
});
