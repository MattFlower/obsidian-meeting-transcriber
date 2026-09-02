/**
 * Minimal, dependency-free handling of the small frontmatter field set this
 * plugin reads and writes (tags, description, source, date, plus any other
 * scalar keys). Avoids pulling in a YAML library.
 */
export interface FrontmatterData {
  tags?: string[];
  description?: string;
  source?: string;
  date?: string;
  [key: string]: unknown;
}

export interface ParsedNote {
  data: FrontmatterData;
  body: string;
  hasFrontmatter: boolean;
}

const FRONTMATTER_DELIM = /^---\s*$/;

function unquote(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') ||
      (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parse leading YAML frontmatter (delimited by `---`) into a small data
 * object plus the remaining body. Only the field shapes this plugin emits or
 * expects are understood: `key: value` scalars, `key:` + `- item` block
 * lists, and `key: [a, b]` flow lists.
 */
export function parseFrontmatter(markdown: string): ParsedNote {
  const lines = markdown.split("\n");
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0])) {
    return { data: {}, body: markdown, hasFrontmatter: false };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { data: {}, body: markdown, hasFrontmatter: false };
  }

  const data: FrontmatterData = {};
  let currentListKey: string | null = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const arr = data[currentListKey];
      if (Array.isArray(arr)) arr.push(unquote(listMatch[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      if (value === "") {
        data[key] = [];
        currentListKey = key;
      } else if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        data[key] =
          inner === ""
            ? []
            : inner.split(",").map((s) => unquote(s));
        currentListKey = null;
      } else {
        data[key] = unquote(value);
        currentListKey = null;
      }
    }
  }

  const body = lines.slice(close + 1).join("\n");
  return { data, body, hasFrontmatter: true };
}

/**
 * Emit frontmatter for a small data object as a `---`-delimited YAML block.
 */
export function emitFrontmatter(data: FrontmatterData): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${item}`);
      }
    } else if (typeof value === "string") {
      lines.push(`${key}: ${quoteString(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export interface TranscriptionNoteInput {
  title: string;
  date: string;
  audioLink: string;
  transcript: string;
  tags: string[];
}

/**
 * Build the markdown for a new transcription note: frontmatter (tags,
 * description placeholder, source link, date), an H1 title, and a
 * `## Transcript` section.
 */
export function transcriptionNoteContent(
  input: TranscriptionNoteInput,
): string {
  const data: FrontmatterData = {
    tags: input.tags,
    description: "",
    source: input.audioLink,
    date: input.date,
  };
  const fm = emitFrontmatter(data);
  const transcript = input.transcript.trim();
  return `${fm}\n\n# ${input.title}\n\n## Transcript\n\n${transcript}\n`;
}

export interface SummaryPatch {
  summary: string;
  description: string;
  tags: string[];
}

/**
 * Insert a `## Summary` section into a note body, replacing an existing one
 * if present. When there is no existing summary, it is inserted at the top
 * of the body — after the leading `# ` H1 line (and its following blank
 * line) when one is present, otherwise at the very start — so the summary is
 * always the first section of the note. Pure so it can be tested.
 */
export function insertSummarySection(body: string, summary: string): string {
  const lines = body.split("\n");
  const section = `## Summary\n\n${summary.trim()}`;

  let summaryStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Summary\s*$/i.test(lines[i].trim())) {
      summaryStart = i;
      break;
    }
  }

  if (summaryStart !== -1) {
    let summaryEnd = lines.length;
    for (let i = summaryStart + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        summaryEnd = i;
        break;
      }
    }
    const before = lines.slice(0, summaryStart);
    const after = lines.slice(summaryEnd);
    return [...before, section, "", ...after].join("\n");
  }

  // No existing Summary: put it at the top of the body, after the leading
  // `# ` H1 line (and its blank line) when present, else at the very start.
  let insertAt = 0;
  if (/^#\s+/.test(lines[0] ?? "")) {
    insertAt = lines.length > 1 && lines[1].trim() === "" ? 2 : 1;
  }
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, section, "", ...after].join("\n");
}

/**
 * Append `text` as a new paragraph at the end of the `## Transcript`
 * section (before the next `## ` heading, or end of file). When no
 * `## Transcript` heading exists, the section is created at the end of the
 * note. Repeated appends keep exactly one blank line between paragraphs
 * (no blank-line pileup). Pure so it can be tested.
 */
export function appendToTranscriptSection(
  markdown: string,
  text: string,
): string {
  const trimmed = text.trim();
  if (!trimmed) return markdown;

  const lines = markdown.split("\n");
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Transcript\s*$/i.test(lines[i].trim())) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    return `${markdown.replace(/\s+$/, "")}\n\n## Transcript\n\n${trimmed}\n`;
  }

  // End of the section: the next `## ` heading, or end of file.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // Existing section content, trimmed of surrounding blank lines so repeated
  // appends do not accumulate blank lines.
  let s = headingIdx + 1;
  let e = end;
  while (s < e && lines[s].trim() === "") s++;
  while (e > s && lines[e - 1].trim() === "") e--;
  const existing = lines.slice(s, e);

  const before = lines.slice(0, headingIdx);
  const after = lines.slice(end);
  const section =
    existing.length === 0
      ? [lines[headingIdx], "", trimmed]
      : [lines[headingIdx], "", ...existing, "", trimmed];
  return [...before, ...section, "", ...after].join("\n");
}

/**
 * Split a note into its raw frontmatter prefix (the `---` block plus a blank
 * separator line, or "" when there is none) and the body that follows. The
 * prefix is the exact original text, so recombining it with a modified body
 * preserves any frontmatter the user wrote (including fields this plugin does
 * not manage).
 */
export interface SplitNote {
  prefix: string;
  body: string;
}

export function splitFrontmatter(markdown: string): SplitNote {
  const lines = markdown.split("\n");
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0])) {
    return { prefix: "", body: markdown };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) return { prefix: "", body: markdown };
  const prefix = lines.slice(0, close + 1).join("\n") + "\n\n";
  const body = lines.slice(close + 1).join("\n");
  return { prefix, body };
}

/**
 * Insert/replace the `## Summary` section in a note's body while preserving
 * the original frontmatter bytes verbatim. Returns the new full markdown.
 * Pure so it can be tested.
 */
export function applySummaryToBody(
  markdown: string,
  summary: string,
): string {
  const { prefix, body } = splitFrontmatter(markdown);
  const bodyText = body.replace(/^\n+/, "");
  const newBody = insertSummarySection(bodyText, summary);
  return prefix + newBody;
}

/**
 * Merge a summary patch into an Obsidian frontmatter object (the one passed
 * to `app.fileManager.processFrontMatter`): union the tags (existing
 * preserved, case-insensitive de-dup) and set the description. Mutates `fm`.
 * Pure so it can be tested.
 */
export function mergeSummaryIntoFrontmatter(
  fm: Record<string, unknown>,
  patch: SummaryPatch,
): void {
  const existing = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
  const merged = [...existing];
  for (const t of patch.tags) {
    if (!merged.some((e) => String(e).toLowerCase() === t.toLowerCase())) {
      merged.push(t);
    }
  }
  fm.tags = merged;
  if (patch.description) fm.description = patch.description;
}

/**
 * Apply a summary to a note: merge tags (union, existing preserved), set the
 * description, and insert/replace the `## Summary` section. Returns the new
 * full markdown. Pure so it can be tested.
 */
export function applySummary(
  markdown: string,
  patch: SummaryPatch,
): string {
  const { data, body, hasFrontmatter } = parseFrontmatter(markdown);

  const existing = Array.isArray(data.tags) ? (data.tags as string[]) : [];
  const merged = [...existing];
  for (const t of patch.tags) {
    if (!merged.some((e) => e.toLowerCase() === t.toLowerCase())) {
      merged.push(t);
    }
  }
  data.tags = merged;
  if (patch.description) data.description = patch.description;

  const bodyText = body.replace(/^\n+/, "");
  const newBody = insertSummarySection(bodyText, patch.summary);
  const fm = emitFrontmatter(data);
  // hasFrontmatter only affects whether we preserve a pre-existing body that
  // had no frontmatter; in both cases we (re)emit frontmatter up front.
  void hasFrontmatter;
  return `${fm}\n\n${newBody}`;
}

/**
 * Make a string safe to use as a file name on common filesystems and in
 * Obsidian (no `\/:*?"<>|#^[]`, no leading/trailing dots or spaces).
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^\[\]]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+/, "")
    .replace(/[-.\s]+$/, "")
    .slice(0, 120);
  return cleaned || "untitled";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar date as `YYYY-MM-DD`. */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Local wall-clock time as `HH:MM`, or `HHmm` with an empty `separator`
 * (the file-name stamp).
 */
export function formatLocalTime(date: Date, separator = ":"): string {
  return `${pad2(date.getHours())}${separator}${pad2(date.getMinutes())}`;
}

/**
 * Build a note file name of the form `YYYY-MM-DD HHmm <name>.md`, stamped in
 * local time. `audioBaseName` should be the audio file name without its
 * extension. The note title and `date` frontmatter are built from the same
 * two formatters so all three agree on the calendar day: an ISO/UTC stamp can
 * already be on the next day while the local file name is not.
 */
export function noteFileName(date: Date, audioBaseName: string): string {
  const stamp = `${formatLocalDate(date)} ${formatLocalTime(date, "")}`;
  return `${stamp} ${sanitizeFileName(audioBaseName)}.md`;
}
