import { clearLine, cursorTo, moveCursor } from "node:readline";

// Cursor-position escape codes have no visual meaning outside a real terminal — writing them to
// a piped/redirected (non-TTY) stream would just pollute the output with raw control bytes. The
// interactive flag is passed in by the caller (which checks stream.isTTY) rather than read here,
// so this class stays simple and directly testable without needing to fake TTY-ness.
const MAX_LINE_CHARS = 100;

function truncate(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

/**
 * A block of N terminal lines that gets redrawn in place rather than accumulating — the pattern
 * behind any CLI's live-updating status area (npm/cargo-style spinners), generalized to N lines
 * so it covers both a single "current tool" line and a multi-line "one line per active subagent"
 * block with the same mechanism.
 */
export class EphemeralRegion {
  private lineCount = 0;

  constructor(
    private readonly stream: NodeJS.WritableStream = process.stdout,
    private readonly interactive: boolean = true,
  ) {}

  /**
   * Redraws the region with new content, clearing whatever it previously showed first.
   *
   * `style`, if given, is applied *after* truncation, never before — a style wrapper (e.g. an
   * ANSI color) adds invisible bytes that still count toward .length, so styling first would
   * silently truncate real content too early (the same class of bug once found in this project's
   * box-drawing code, before boxes were removed: pad/truncate the plain text, style the result).
   */
  update(lines: string[], style?: (line: string) => string): void {
    const truncated = lines.map(truncate);
    const rendered = style ? truncated.map(style) : truncated;
    if (!this.interactive) {
      // No overwrite capability — fall back to plain sequential lines so piped/redirected output
      // stays readable (and still shows every state, just not collapsed).
      for (const line of rendered) this.stream.write(`${line}\n`);
      return;
    }
    this.clearRows(this.lineCount);
    this.stream.write(rendered.join("\n"));
    this.lineCount = truncated.length;
  }

  /** Removes the region entirely, leaving the cursor at column 0 where its first line was —
   * call this before printing anything permanent, so nothing ephemeral lingers in scrollback. */
  clear(): void {
    if (!this.interactive || this.lineCount === 0) return;
    this.clearRows(this.lineCount);
    this.lineCount = 0;
  }

  get isActive(): boolean {
    return this.lineCount > 0;
  }

  private clearRows(count: number): void {
    for (let i = 0; i < count; i++) {
      cursorTo(this.stream, 0);
      clearLine(this.stream, 0);
      if (i < count - 1) moveCursor(this.stream, 0, -1);
    }
  }
}
