export function selectPairs(input: string, total: number): number[] {
  const selected = new Set<number>();
  const value = input.trim();
  if (value === "all" && !total) throw new Error("No prepared pairs. Run mise run prepare first.");
  for (const part of (value === "all" ? `1-${total}` : value).split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!range) throw new Error(`Invalid selection "${part.trim()}". Use 1, 1-10,15 or all.`);
    const first = Number(range[1]);
    const last = Number(range[2] ?? first);
    if (first < 1 || last < first) throw new Error(`Invalid pair range "${part.trim()}".`);
    if (last > total) throw new Error(`Pair ${last} was not found in pairs.jsonl.`);
    for (let n = first; n <= last; n++) selected.add(n);
  }
  return [...selected].sort((a, b) => a - b);
}
