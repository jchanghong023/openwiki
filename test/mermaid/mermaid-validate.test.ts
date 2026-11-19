import { describe, expect, test } from "vitest";
import {
  degradeInvalidMermaidFences,
  findInvalidMermaidFences,
} from "../../src/mermaid/validate.ts";

const VALID_SEQUENCE = `sequenceDiagram
  loop retry
    alt ready
      Alice->>Bob: Hello
    else busy
      Bob-->>Alice: Later
    end
  end %% end retry`;

const VALID_STATE = `stateDiagram-v2
  state "Active" as Active {
    [*] --> Running
    note right of Running
      } is just note text
    end note
  }`;

const VALID_FLOWCHART = `flowchart TD
  %% A[commented out
  subgraph Process
    A["Reach the end; next<br/> [step]"] -->|review [optional]| B{Check}
    B --> C[Line one
    Line two]
  end`;

const BROKEN_LABEL = `flowchart TD
  A[Start --> B[Done]`;

const BROKEN_RESERVED_END = `flowchart TD
  A[Start] --> end[The End]`;

/** Wraps a diagram body in a ```mermaid fenced block. */
function mermaidFence(body: string): string {
  return ["```mermaid", body, "```"].join("\n");
}

describe("findInvalidMermaidFences", () => {
  test.each([
    ["nested unclosed flowchart label", BROKEN_LABEL, /closing `\]`/u],
    ["unclosed flowchart label at EOF", "flowchart LR\nA --> B[Done", /closing `\]`/u],
    ["reserved flowchart node ID", BROKEN_RESERVED_END, /reserved word/u],
    ["unclosed sequence block", "sequenceDiagram\nalt ready\nAlice->>Bob: Hello", /alt.*missing `end`/u],
    ["unexpected sequence end", "sequenceDiagram\nAlice->>Bob: Hello\nend", /Unexpected `end`/u],
    ["unclosed composite state", "stateDiagram-v2\nstate Active {\n[*] --> Running", /state.*missing `\}`/u],
    ["unexpected composite close", "stateDiagram-v2\n[*] --> Running\n}", /Unexpected `\}`/u],
  ] as const)("reports %s", async (_name, body, reason) => {
    const errors = await findInvalidMermaidFences(mermaidFence(body));
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(reason);
  });

  test("returns nothing when a document has no mermaid fences", async () => {
    expect(await findInvalidMermaidFences("# Page\n\nProse.")).toHaveLength(0);
  });
});

describe("degradeInvalidMermaidFences", () => {
  test("preserves valid diagrams and syntax outside the checked subset byte for byte", async () => {
    const markdown = [
      "---\ntitle: Main flow\n---\n" + VALID_FLOWCHART,
      VALID_SEQUENCE,
      VALID_STATE,
      "erDiagram\nUSER ||--o{ ORDER : places",
      'flowchart LR\nA@{ shape: rect, label: "items [a; b]" } --> B',
      "stateDiagram-v2\nstate A { B --> C }",
      "sequenceDiagram; loop retry; A->>B: Hi; end",
    ].map(mermaidFence).join("\n\n");

    expect(await degradeInvalidMermaidFences(markdown)).toEqual({
      content: markdown,
      degraded: 0,
    });
  });

  test("degrades only failing fences and keeps the valid ones", async () => {
    const markdown = [
      "# Page",
      mermaidFence(VALID_SEQUENCE),
      mermaidFence(BROKEN_LABEL),
    ].join("\n\n");

    const result = await degradeInvalidMermaidFences(markdown);

    expect(result.degraded).toBe(1);
    // The valid diagram is left as a mermaid fence.
    expect(result.content).toContain(mermaidFence(VALID_SEQUENCE));
    // The broken one is degraded, with the repair marker and a text fence.
    expect(result.content).toContain("<!-- openwiki: mermaid parse failed");
    expect(result.content).toContain("```text");
    expect(result.content).toContain(BROKEN_LABEL);
  });

  test("produces output that itself passes validation", async () => {
    const markdown = mermaidFence(BROKEN_RESERVED_END);

    const result = await degradeInvalidMermaidFences(markdown);

    expect(result.degraded).toBe(1);
    expect(await findInvalidMermaidFences(result.content)).toHaveLength(0);
  });
});
