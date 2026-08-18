import { describe, expect, it } from "vitest";
import {
  applySummary,
  applySummaryToBody,
  emitFrontmatter,
  insertSummarySection,
  mergeSummaryIntoFrontmatter,
  noteFileName,
  parseFrontmatter,
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
  it("appends at the end when no Transcript heading exists", () => {
    const out = insertSummarySection("# T\n\nbody", "S");
    expect(out).toContain("## Summary");
    expect(out.trimEnd().endsWith("S")).toBe(true);
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
