import { useEffect, useRef } from "react";
import { CodeBlockContent, CodeBlockLine } from "./ui/code-block";
import type { SourceRange } from "../../src/evidence.ts";

export function SourceLines({ text, startLine = 1, citation }: { text: string; startLine?: number; citation?: SourceRange }) {
  const first = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (citation) first.current?.focus(); }, [citation]);
  return <CodeBlockContent className="max-h-96" lineNumbers startLine={startLine}>
    {text.split(/\r?\n/).map((line, i) => {
      const n = startLine + i;
      const targeted = n === citation?.startLine;
      return <CodeBlockLine key={n} ref={targeted ? first : undefined} tabIndex={targeted ? -1 : undefined}
        variant={citation && n >= citation.startLine && n <= citation.endLine ? "highlighted" : "default"}>{line}</CodeBlockLine>;
    })}
  </CodeBlockContent>;
}
