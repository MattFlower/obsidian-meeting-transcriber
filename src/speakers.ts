import type { TimedWord } from "./transcriber";

/**
 * Speaker attribution: combine a diarizer's time segments with the
 * recognizer's timed words into a transcript of labelled speaker turns, and
 * read such a transcript back from markdown.
 *
 * The two inputs never line up exactly. Diarization works on acoustic frames
 * and the recognizer on its own alignment, so words straddle segment
 * boundaries, land in the gaps between segments, or sit under two segments
 * where the diarizer decided people talked over each other. The pipeline:
 *
 *   assignWordSpeakers  - one cluster id per word (largest overlap wins)
 *   labelSpeakers       - ids become "Speaker N" in order of first appearance
 *   buildTurns          - consecutive equal labels merge into turns, and turns
 *                         too short to be real speech are absorbed by a
 *                         neighbour
 *   renumberTurns       - close the numbering gaps that smoothing opened
 *   renderSpeakerTranscript / parseSpeakerTranscript - markdown out and in
 *
 * Everything is a pure function over plain data so it can be tested without
 * a model, and the markdown form is the source of truth once written: a user
 * renaming "Speaker 2" to "Alice" in the note must survive a re-parse.
 */

/** One diarization segment: `speaker` is the clustering's integer id. */
export interface SpeakerSegment {
  start: number;
  end: number;
  speaker: number;
}

/**
 * A run of consecutive words by one speaker; `""` means unlabelled. `start`
 * and `end` are seconds; they are absent on turns parsed back from markdown,
 * where the timing is gone.
 */
export interface SpeakerTurn {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
}

export type { TimedWord };

export interface TurnOptions {
  /** A turn with fewer words than this is absorbed by a neighbouring turn. */
  minTurnWords?: number;
  /** A silence at least this long starts a new paragraph in unlabelled text. */
  pauseParagraphSeconds?: number;
}

export const DEFAULT_TURN_OPTIONS: Required<TurnOptions> = {
  minTurnWords: 3,
  pauseParagraphSeconds: 2,
};

export interface SpeakerTranscriptResult {
  text: string;
  /** Distinct labelled speakers left after smoothing. */
  speakers: number;
}

/** The label stem shared by labelSpeakers and renumberTurns. */
const SPEAKER_PREFIX = "Speaker ";

/** The id a word gets when there are no segments to attribute it to. */
const NO_SPEAKER = -1;

/**
 * Overlaps and edge distances are differences of float timestamps, so two
 * segments that both fully cover a word can come out an ulp apart. Anything
 * within a microsecond is a tie; no diarizer is that precise.
 */
const TIE_EPSILON = 1e-6;

function resolveTurnOptions(opts?: TurnOptions): Required<TurnOptions> {
  return {
    minTurnWords: opts?.minTurnWords ?? DEFAULT_TURN_OPTIONS.minTurnWords,
    pauseParagraphSeconds:
      opts?.pauseParagraphSeconds ??
      DEFAULT_TURN_OPTIONS.pauseParagraphSeconds,
  };
}

function compareSegments(a: SpeakerSegment, b: SpeakerSegment): number {
  return a.start - b.start || a.end - b.end;
}

/**
 * Break a tie between equally good segments. Keeping the previous word's
 * speaker stops a run of words under two overlapping segments from
 * flip-flopping between them; failing that, the earliest segment (then the
 * lowest id) makes the choice independent of the diarizer's output order.
 */
function pickTied(tied: SpeakerSegment[], prev: number | null): number {
  if (tied.length === 0) return NO_SPEAKER;
  if (prev !== null) {
    for (const s of tied) {
      if (s.speaker === prev) return prev;
    }
  }
  let best = tied[0];
  for (let i = 1; i < tied.length; i++) {
    const s = tied[i];
    if (
      s.start < best.start ||
      (s.start === best.start && s.speaker < best.speaker)
    ) {
      best = s;
    }
  }
  return best.speaker;
}

/**
 * Attribute every word to a diarization segment, returning one speaker id
 * per word (`-1` for all of them when there are no segments).
 *
 * A word goes to the segment it overlaps most; a zero-length word is a point
 * and goes to whichever segment contains it (half-open, so a word exactly on
 * a boundary belongs to the segment that starts there). A word in a gap
 * between segments goes to the nearer edge, measured from the word's
 * midpoint so the decision does not hinge on which end the recognizer padded.
 *
 * Words arrive in time order, so this is a sweep: a pointer skips segments
 * that ended before the current word and stays put for the rest, and each
 * word only scans the segments that start before it ends. That is O(n + m)
 * unless segments are nested many deep, which real diarizer output is not.
 */
export function assignWordSpeakers(
  words: TimedWord[],
  segments: SpeakerSegment[],
): number[] {
  const ids = new Array<number>(words.length).fill(NO_SPEAKER);
  if (segments.length === 0) return ids;
  const sorted = segments.slice().sort(compareSegments);
  const m = sorted.length;

  // Segments before `lo` end at or before the current word. They can never
  // overlap a later word, but the ones ending latest are the "before" edge
  // of any gap, so they are remembered.
  let lo = 0;
  let passedEnd = -Infinity;
  let passed: SpeakerSegment[] = [];
  let prev: number | null = null;

  for (let i = 0; i < words.length; i++) {
    const ws = words[i].start;
    const we = Math.max(words[i].end, ws);
    const isPoint = we <= ws;

    while (lo < m && sorted[lo].end <= ws) {
      const s = sorted[lo];
      if (s.end > passedEnd) {
        passedEnd = s.end;
        passed = [s];
      } else if (s.end === passedEnd) {
        passed.push(s);
      }
      lo++;
    }

    // Every candidate starts before the word ends (or at the point), so the
    // scan stops at the first segment that starts too late.
    const candidates: SpeakerSegment[] = [];
    const scores: number[] = [];
    let bestScore = 0;
    for (let j = lo; j < m; j++) {
      const s = sorted[j];
      if (isPoint ? s.start > ws : s.start >= we) break;
      let score: number;
      if (isPoint) {
        score = s.end > ws ? 1 : 0;
      } else {
        score = Math.min(we, s.end) - Math.max(ws, s.start);
      }
      if (score <= 0) continue;
      candidates.push(s);
      scores.push(score);
      if (score > bestScore) bestScore = score;
    }

    let tied: SpeakerSegment[];
    if (candidates.length > 0) {
      tied = candidates.filter(
        (_, k) => scores[k] >= bestScore - TIE_EPSILON,
      );
    } else {
      const mid = (ws + we) / 2;
      const beforeDist = passed.length > 0 ? mid - passedEnd : Infinity;
      const after: SpeakerSegment[] = [];
      let afterDist = Infinity;
      if (lo < m) {
        const firstStart = sorted[lo].start;
        afterDist = firstStart - mid;
        for (let j = lo; j < m && sorted[j].start === firstStart; j++) {
          after.push(sorted[j]);
        }
      }
      if (beforeDist < afterDist - TIE_EPSILON) tied = passed;
      else if (afterDist < beforeDist - TIE_EPSILON) tied = after;
      else tied = passed.concat(after);
    }

    const chosen = pickTied(tied, prev);
    ids[i] = chosen;
    prev = chosen;
  }
  return ids;
}

/**
 * Turn cluster ids into "Speaker 1", "Speaker 2", ... numbered by first
 * appearance, so the first voice in the meeting is always Speaker 1 whatever
 * arbitrary ids the clustering handed out. A negative id (the `-1` of an
 * unattributed word) becomes the empty, unlabelled label.
 */
export function labelSpeakers(ids: number[]): string[] {
  const names = new Map<number, string>();
  return ids.map((id) => {
    if (id < 0) return "";
    let name = names.get(id);
    if (name === undefined) {
      name = `${SPEAKER_PREFIX}${names.size + 1}`;
      names.set(id, name);
    }
    return name;
  });
}

/** A maximal run of consecutively labelled words: indices `[from, to)`. */
interface WordRun {
  label: string;
  from: number;
  to: number;
}

function runsFromLabels(labels: string[]): WordRun[] {
  const runs: WordRun[] = [];
  for (let i = 0; i < labels.length; i++) {
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.label === labels[i]) {
      last.to = i + 1;
    } else {
      runs.push({ label: labels[i], from: i, to: i + 1 });
    }
  }
  return runs;
}

function mergeAdjacentRuns(runs: WordRun[]): WordRun[] {
  const merged: WordRun[] = [];
  for (const run of runs) {
    const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (last !== undefined && last.label === run.label) {
      last.to = run.to;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

/**
 * Absorb runs shorter than `minWords` into a neighbour. A one- or two-word
 * "turn" is almost always a diarization wobble at a boundary, not a real
 * interjection, and it is handed to whichever neighbour is closer in time
 * (the previous one on a tie, since a wobble usually trails the speaker who
 * was already talking). Absorbing relabels the words, so the run merges
 * with that neighbour and the total shrinks by at least one each pass; the
 * loop therefore always terminates. A lone run has no neighbour and stays.
 */
function smoothRuns(
  words: TimedWord[],
  runs: WordRun[],
  minWords: number,
): WordRun[] {
  let current = runs;
  for (;;) {
    if (current.length < 2) return current;
    const i = current.findIndex((r) => r.to - r.from < minWords);
    if (i === -1) return current;
    const run = current[i];
    const prev = i > 0 ? current[i - 1] : undefined;
    const next = i + 1 < current.length ? current[i + 1] : undefined;
    let target: WordRun;
    if (prev !== undefined && next !== undefined) {
      const gapPrev = words[run.from].start - words[prev.to - 1].end;
      const gapNext = words[next.from].start - words[run.to - 1].end;
      target = gapNext < gapPrev ? next : prev;
    } else if (prev !== undefined) {
      target = prev;
    } else if (next !== undefined) {
      target = next;
    } else {
      return current;
    }
    run.label = target.label;
    current = mergeAdjacentRuns(current);
  }
}

/** Word texts joined by single spaces; blank words contribute nothing. */
function joinWords(words: TimedWord[], from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i < to; i++) {
    const text = words[i].text.trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

/**
 * Group words into speaker turns. `labels[i]` labels `words[i]`; the two
 * arrays must be the same length. Consecutive equal labels merge, then
 * turns shorter than `minTurnWords` are smoothed away (see smoothRuns). The
 * empty label is a label like any other, so a stray unlabelled word inside
 * a speaker's turn is absorbed too. Words keep their order throughout.
 */
export function buildTurns(
  words: TimedWord[],
  labels: string[],
  opts?: TurnOptions,
): SpeakerTurn[] {
  if (labels.length !== words.length) {
    throw new RangeError(
      `buildTurns: ${words.length} words but ${labels.length} labels`,
    );
  }
  const { minTurnWords } = resolveTurnOptions(opts);
  const runs = smoothRuns(words, runsFromLabels(labels), minTurnWords);
  return runs.map((run) => ({
    speaker: run.label,
    text: joinWords(words, run.from, run.to),
    start: words[run.from].start,
    end: words[run.to - 1].end,
  }));
}

/**
 * The per-word labels after the same smoothing `buildTurns` applies: tiny
 * runs are absorbed into their nearer neighbour. Lets a caller smooth one
 * lane's diarized labels before merging them with labels that are fixed by
 * construction (a separately captured microphone), which must never be
 * absorbed.
 */
export function smoothLabels(
  words: TimedWord[],
  labels: string[],
  opts?: TurnOptions,
): string[] {
  if (labels.length !== words.length) {
    throw new RangeError(
      `smoothLabels: ${words.length} words but ${labels.length} labels`,
    );
  }
  const { minTurnWords } = resolveTurnOptions(opts);
  const out = labels.slice();
  for (const run of smoothRuns(words, runsFromLabels(labels), minTurnWords)) {
    for (let i = run.from; i < run.to; i++) out[i] = run.label;
  }
  return out;
}

/**
 * Speaker transcript for words that partly carry a fixed label (`fixed[i]`,
 * e.g. "Me" for a separately captured microphone) and partly need
 * diarization (`null`). The open words are assigned and smoothed on their
 * own, so a fixed one-word interjection is never absorbed into a diarized
 * neighbour; when diarization finds at most one voice among them they all
 * get `fallback` instead of a numbered label. `speakers` counts distinct
 * labels, fixed ones included.
 */
export function mixedSpeakerTranscript(
  words: TimedWord[],
  fixed: (string | null)[],
  segments: SpeakerSegment[],
  fallback: string,
  opts?: TurnOptions,
): SpeakerTranscriptResult {
  if (fixed.length !== words.length) {
    throw new RangeError(
      `mixedSpeakerTranscript: ${words.length} words but ${fixed.length} labels`,
    );
  }
  if (fixed.every((label) => label === null)) {
    return speakerTranscript(words, segments, opts);
  }
  const openIndexes: number[] = [];
  fixed.forEach((label, i) => {
    if (label === null) openIndexes.push(i);
  });
  const openWords = openIndexes.map((i) => words[i]);
  let openLabels = smoothLabels(
    openWords,
    labelSpeakers(assignWordSpeakers(openWords, segments)),
    opts,
  );
  const distinctOpen = new Set(openLabels.filter((label) => label !== ""));
  if (distinctOpen.size <= 1) openLabels = openLabels.map(() => fallback);

  const labels = fixed.map((label) => label ?? "");
  openIndexes.forEach((wordIndex, k) => {
    labels[wordIndex] = openLabels[k];
  });
  // No further smoothing: every label is now either fixed or already smoothed.
  const turns = renumberTurns(buildTurns(words, labels, { minTurnWords: 1 }));
  const speakers = new Set(
    turns.map((turn) => turn.speaker).filter((label) => label !== ""),
  ).size;
  return { text: renderSpeakerTranscript(turns), speakers };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renumber generated labels (`<prefix><digits>`) by first appearance so
 * that, after smoothing has removed a speaker, the survivors are still
 * "Speaker 1, Speaker 2, ..." with no hole. Any other label ("Me", "Alice",
 * "") was chosen by a person or by a fixed rule and is left alone. Returns
 * new turn objects; the input is not touched.
 */
export function renumberTurns(
  turns: SpeakerTurn[],
  prefix = SPEAKER_PREFIX,
): SpeakerTurn[] {
  const generated = new RegExp(`^${escapeRegExp(prefix)}\\d+$`);
  const renamed = new Map<string, string>();
  return turns.map((turn) => {
    if (!generated.test(turn.speaker)) return { ...turn };
    let label = renamed.get(turn.speaker);
    if (label === undefined) {
      label = `${prefix}${renamed.size + 1}`;
      renamed.set(turn.speaker, label);
    }
    return { ...turn, speaker: label };
  });
}

/**
 * Plain paragraphs from timed words: a silence of at least `pauseSeconds`
 * between one word's end and the next word's start starts a new paragraph.
 * This is the unlabelled rendering for a recording with a single voice,
 * where pauses are the only structure there is.
 */
export function paragraphsFromWords(
  words: TimedWord[],
  pauseSeconds = DEFAULT_TURN_OPTIONS.pauseParagraphSeconds,
): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (
      i > 0 &&
      current.length > 0 &&
      words[i].start - words[i - 1].end >= pauseSeconds
    ) {
      paragraphs.push(current.join(" "));
      current = [];
    }
    const text = words[i].text.trim();
    if (text) current.push(text);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n\n");
}

/** A blank line, however much whitespace it carries. */
const PARAGRAPH_BREAK = /\n\s*\n/;

/**
 * `**Label:** text` or `**Label**: text`. The label may not contain `*` or
 * a newline, which is what keeps ordinary bold text (`**really** important`)
 * from being mistaken for a speaker.
 */
const LABELLED_PARAGRAPH = /^\*\*([^*\n]+?)(?::\*\*|\*\*:)\s*([\s\S]*)$/;

/**
 * Render turns as markdown paragraphs separated by blank lines: a labelled
 * turn as `**Label:** text`, an unlabelled one as bare text. When a turn's
 * text already spans several paragraphs (a normalizer may return them), the
 * label goes on the first and the rest follow as plain continuation
 * paragraphs, which is exactly the shape parseSpeakerTranscript reads back.
 * Blank turns are dropped rather than rendered as an empty label.
 */
export function renderSpeakerTranscript(turns: SpeakerTurn[]): string {
  const paragraphs: string[] = [];
  for (const turn of turns) {
    const label = turn.speaker.trim();
    const parts = turn.text
      .split(PARAGRAPH_BREAK)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    parts.forEach((part, k) => {
      paragraphs.push(k === 0 && label ? `**${label}:** ${part}` : part);
    });
  }
  return paragraphs.join("\n\n");
}

/**
 * The inverse of renderSpeakerTranscript. A labelled paragraph starts a
 * turn; any other paragraph continues the current turn, or, before the
 * first label, forms one unlabelled leading turn. Returns null when no
 * paragraph carries a label, i.e. the text is a plain transcript and not a
 * speaker transcript at all. Labels are taken as written, so a user's
 * renames ("Alice") come back intact.
 */
export function parseSpeakerTranscript(
  markdown: string,
): SpeakerTurn[] | null {
  const turns: SpeakerTurn[] = [];
  let sawLabel = false;
  for (const raw of markdown.split(PARAGRAPH_BREAK)) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    const match = LABELLED_PARAGRAPH.exec(paragraph);
    const label = match ? match[1].trim() : "";
    if (match && label) {
      sawLabel = true;
      turns.push({ speaker: label, text: match[2].trim() });
      continue;
    }
    if (turns.length === 0) {
      turns.push({ speaker: "", text: paragraph });
      continue;
    }
    const last = turns[turns.length - 1];
    last.text = last.text ? `${last.text}\n\n${paragraph}` : paragraph;
  }
  return sawLabel ? turns : null;
}

/**
 * The whole pipeline: words plus diarization segments in, transcript text
 * out. With one speaker (or none) the text is plain pause-split paragraphs,
 * because a label on every paragraph of a monologue is noise; with two or
 * more it is the labelled speaker transcript.
 */
export function speakerTranscript(
  words: TimedWord[],
  segments: SpeakerSegment[],
  opts?: TurnOptions,
): SpeakerTranscriptResult {
  const options = resolveTurnOptions(opts);
  const labels = labelSpeakers(assignWordSpeakers(words, segments));
  const turns = renumberTurns(buildTurns(words, labels, options));
  const speakers = new Set(
    turns.map((t) => t.speaker).filter((s) => s !== ""),
  ).size;
  if (speakers <= 1) {
    return {
      text: paragraphsFromWords(words, options.pauseParagraphSeconds),
      speakers,
    };
  }
  return { text: renderSpeakerTranscript(turns), speakers };
}
