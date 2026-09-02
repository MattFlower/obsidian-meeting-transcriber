/**
 * Headless stand-ins for the slice of the Obsidian API that src/live-panel.ts
 * touches. The `obsidian` npm package is types-only (no runtime entry), so
 * vitest.config.ts aliases the module here. `FakeEl` mimics the DOM helpers
 * Obsidian adds to HTMLElement (createDiv/createEl/setText/…) plus the few
 * native properties the panel reads (value, disabled, options).
 */

export interface ElOptions {
  text?: string;
  cls?: string;
}

/** `new Option(text, value)`, used to populate the panel's <select>s. */
export class Option {
  readonly text: string;
  readonly value: string;

  constructor(text: string, value: string) {
    this.text = text;
    this.value = value;
  }
}

export class FakeEl {
  readonly tag: string;
  readonly children: FakeEl[] = [];
  readonly classes = new Set<string>();
  readonly options: Option[] = [];
  text = "";
  value = "";
  disabled = false;
  private clickHandler: (() => void) | null = null;

  constructor(tag = "div") {
    this.tag = tag;
  }

  empty(): void {
    this.children.length = 0;
    this.options.length = 0;
    this.text = "";
  }

  createDiv(opts?: ElOptions): FakeEl {
    return this.createEl("div", opts);
  }

  createSpan(opts?: ElOptions): FakeEl {
    return this.createEl("span", opts);
  }

  createEl(tag: string, opts?: ElOptions): FakeEl {
    const el = new FakeEl(tag);
    if (opts?.text) el.text = opts.text;
    if (opts?.cls) el.classes.add(opts.cls);
    this.children.push(el);
    return el;
  }

  setText(text: string): void {
    this.text = text;
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  removeClass(cls: string): void {
    this.classes.delete(cls);
  }

  appendChild(option: Option): void {
    this.options.push(option);
    if (this.options.length === 1) this.value = option.value;
  }

  onClickEvent(handler: () => void): void {
    this.clickHandler = handler;
  }

  /** Simulate a user click on this element. */
  click(): void {
    this.clickHandler?.();
  }

  /** All descendants (depth-first) matching `predicate`. */
  findAll(predicate: (el: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const child of this.children) {
      if (predicate(child)) out.push(child);
      out.push(...child.findAll(predicate));
    }
    return out;
  }
}

export class WorkspaceLeaf {
  readonly app: unknown;

  constructor(app: unknown = {}) {
    this.app = app;
  }
}

export class ItemView {
  readonly leaf: WorkspaceLeaf;
  readonly app: unknown;
  readonly contentEl = new FakeEl("div");

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app;
  }
}

export class Notice {
  /** Every message shown since the last reset, for assertions. */
  static shown: string[] = [];
  readonly messageEl = new FakeEl("div");

  constructor(message: string, _timeoutMs?: number) {
    Notice.shown.push(message);
    this.messageEl.text = message;
  }

  hide(): void {
    // no-op
  }
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "md";
}
