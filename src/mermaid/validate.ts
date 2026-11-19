import { extractMermaidFences, type MermaidFence } from "./fences.js";

/**
 * A detected structural error in a Mermaid fence.
 */
export interface MermaidFenceError {
  /**
   * The fence containing the error.
   */
  fence: MermaidFence;

  /**
   * A fixed diagnostic safe to write in an HTML comment.
   */
  error: string;
}

/**
 * The result of degrading the invalid fences in a single document.
 */
export interface MermaidDegradeResult {
  /**
   * The rewritten document, identical to the input when nothing degraded.
   */
  content: string;

  /**
   * How many fences were degraded to text fences.
   */
  degraded: number;
}

// Skip optional metadata before recognizing the diagram type.
function diagramBody(text: string): string {
  return text
    .trimStart()
    .replace(/^---[ \t]*\r?\n(?:[\s\S]*?\n)?---[ \t]*(?:\r?\n|$)/u, "")
    .replace(/^(?:\s*%%(?:\{[\s\S]*?\}%%|[^\n]*))*/u, "")
    .trimStart();
}

const FLOW_TOKEN =
  /^[ \t]*%%[^\n]*|"[^"]*(?:"|$)|\|[^|\n]*\||@\{|\[(?:\[|\(|[/\\])|^[ \t]*end(?=[ \t]*(?:\[|-->))|-->[ \t]*(?:\|[^|\n]*\|[ \t]*)?end(?=[ \t]*(?:\[|-->|;|$))|[\[\](){}]/gmu;

function checkFlowchart(body: string): string | undefined {
  let close: string | undefined;
  let squareNode = false;
  for (const match of body.matchAll(FLOW_TOKEN)) {
    const token = match[0];
    if (close !== undefined) {
      if (token === close) {
        close = undefined;
        squareNode = false;
      } else if (squareNode && token === "[") {
        return "A square-bracket node label is missing its closing `]` before another `[`.";
      }
      continue;
    }
    // Alternative shapes have their own delimiters; don't guess.
    if (token === "@{" || (token.startsWith("[") && token.length > 1)) return;
    if (token === "[") {
      close = "]";
      squareNode = /[\p{L}\p{N}_-]/u.test(body[match.index - 1] ?? "");
    } else if (token === "(" || token === "{") {
      close = token === "(" ? ")" : "}";
    } else if (token.trimStart().startsWith("end") || token.startsWith("-->")) {
      return "`end` is a reserved word and cannot be used as a flowchart node ID.";
    }
  }
  if (squareNode) return "A square-bracket node label is missing its closing `]`.";
}

function checkBlocks(body: string, stateDiagram: boolean): string | undefined {
  const blocks: Array<{ name: string; line: number }> = [];
  let inNote = false;
  for (const [i, raw] of body.split("\n").entries()) {
    if (i === 0) continue;
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("%%")) {
      if (line.startsWith("%%{") && !line.endsWith("}%%")) return;
      continue;
    }
    if (inNote) {
      if (/^end[ \t]+note[ \t]*(?:%%.*)?$/u.test(line)) inNote = false;
      continue;
    }
    if (stateDiagram && /^note\b/u.test(line)) {
      if (/^note[ \t]+(?:left|right)[ \t]+of[ \t]+[\w.-]+[ \t]*(?:%%.*)?$/u.test(line)) {
        inNote = true;
      } else if (!line.includes(":")) {
        return;
      }
      continue;
    }
    // Compound statements can hide a block opener or closer on the same line.
    if (line.includes(";")) return;
    const opener = stateDiagram
      ? /^state[ \t]+(?:[\w.-]+|"[^"]+"[ \t]+as[ \t]+[\w.-]+)[ \t]*\{[ \t]*(?:%%.*)?$/u.exec(line)
      : /^(loop|alt|opt|par|par_over|critical|break|rect|box)(?:[ \t]+|$)/u.exec(line);
    if (opener) {
      blocks.push({ name: stateDiagram ? "composite state" : opener[1], line: i + 1 });
    } else if ((stateDiagram ? /^\}[ \t]*(?:%%.*)?$/u : /^end[ \t]*(?:%%.*)?$/u).test(line)) {
      if (!blocks.pop()) {
        return `Unexpected ${stateDiagram ? "`}`" : "`end`"} at diagram line ${i + 1}.`;
      }
    } else if (stateDiagram && /[{}]/u.test(line)) {
      // Inline composite states and other forms outside the checked subset.
      return;
    }
  }
  const block = blocks.at(-1);
  if (block && !inNote) {
    return `Unclosed ${block.name} block at diagram line ${block.line}; missing ${stateDiagram ? "`}`" : "`end`"}.`;
  }
}

function structuralError(text: string): string | undefined {
  const body = diagramBody(text);
  const newline = body.indexOf("\n");
  const heading = (newline === -1 ? body : body.slice(0, newline)).trimEnd();
  if (/^(?:flowchart|graph)(?:[ \t]+(?:TB|TD|BT|RL|LR))?[ \t]*(?:%%.*)?$/u.test(heading)) {
    return newline === -1 ? undefined : checkFlowchart(body.slice(newline + 1));
  }
  if (/^sequenceDiagram[ \t]*(?:%%.*)?$/u.test(heading)) return checkBlocks(body, false);
  if (/^stateDiagram(?:-v2)?[ \t]*(?:%%.*)?$/u.test(heading)) return checkBlocks(body, true);
}

/** Reports definite structural errors in the checked subset, not full syntax validity. */
export async function findInvalidMermaidFences(
  markdown: string,
): Promise<MermaidFenceError[]> {
  return extractMermaidFences(markdown).flatMap((fence) => {
    const reason = structuralError(fence.body);
    return reason === undefined ? [] : [{ fence, error: reason }];
  });
}

/**
 * Degrades fences with detected structural errors to plain ```text fences.
 * The diagnostic comment lets a later update find and repair the diagram.
 * Unrecognized syntax and diagram types are left unchanged.
 */
export async function degradeInvalidMermaidFences(
  markdown: string,
): Promise<MermaidDegradeResult> {
  const errors = await findInvalidMermaidFences(markdown);
  if (errors.length === 0) {
    return { content: markdown, degraded: 0 };
  }

  const lines = markdown.split("\n");

  // Rewrite bottom-up so that earlier line indices stay valid as lines are spliced.
  for (const { fence, error } of [...errors].reverse()) {
    const comment =
      `${fence.indent}<!-- openwiki: mermaid parse failed and this diagram ` +
      `was converted to a text fence so it does not break rendering. Fix the ` +
      `diagram source and restore the mermaid fence. Reason: ${error} -->`;
    lines.splice(
      fence.openLine,
      fence.closeLine - fence.openLine + 1,
      comment,
      `${fence.indent}${fence.marker}text`,
      ...fence.body.split("\n"),
      `${fence.indent}${fence.marker}`,
    );
  }

  return { content: lines.join("\n"), degraded: errors.length };
}
