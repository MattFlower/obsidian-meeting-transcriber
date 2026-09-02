/**
 * Owner-tagged text for the plugin's single status-bar item.
 *
 * Several activities can be in flight at once — a file transcription, a
 * model download, a summary, a live recording refreshing its clock every
 * second — and they all share one status bar item. Writing to it directly
 * meant the last writer won: an open live panel cleared the bar once a
 * second and erased "Transcribing…" from the file path within moments.
 *
 * Here each activity sets or clears only its own line, keyed by an owner
 * tag. The bar shows every non-empty line joined with " · " in first-set
 * order (capped at `maxLength` characters, since the status bar is a shared
 * strip), and the renderer runs only when the visible text actually changes,
 * so a per-second refresh that produces the same text costs nothing.
 */
export class StatusBoard {
  private readonly lines = new Map<string, string>();
  private readonly render: (text: string) => void;
  private readonly maxLength: number;
  private rendered = "";

  constructor(render: (text: string) => void, maxLength = 100) {
    this.render = render;
    this.maxLength = maxLength;
  }

  /** Set `owner`'s line; an empty string clears it. */
  set(owner: string, text: string): void {
    if (text === "") {
      this.lines.delete(owner);
    } else {
      this.lines.set(owner, text);
    }
    this.flush();
  }

  /**
   * The text currently shown: every owner's line joined with " · ",
   * truncated with an ellipsis beyond `maxLength` characters.
   */
  text(): string {
    const joined = Array.from(this.lines.values()).join(" · ");
    if (joined.length <= this.maxLength) return joined;
    return `${joined.slice(0, this.maxLength - 1)}…`;
  }

  private flush(): void {
    const next = this.text();
    if (next === this.rendered) return;
    this.rendered = next;
    this.render(next);
  }
}
