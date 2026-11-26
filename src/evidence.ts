import type { Lookup } from "./source-tools.ts";

export type SourceRange = { startLine: number; endLine: number };

export function coversCitation(lookup: Lookup, range: SourceRange & { path?: string }) {
  return lookup.tool === "read" && !lookup.error && lookup.args.path === range.path
    && lookup.args.startLine <= range.startLine && lookup.args.endLine >= range.endLine;
}
