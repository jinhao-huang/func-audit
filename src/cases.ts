import { open } from "node:fs/promises";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexDescriptions, nearestDescriptions } from "./embeddings.ts";

export type CaseHit = {
  line: number;
  cve: string;
  cwe: string;
  description: string;
  commitMessage: string;
  excerpt: string;
};
export type CaseSearch = { query: string; hits: CaseHit[] };

export async function buildCaseIndex(file: string, destination: string) {
  using db = new DatabaseSync(destination);
  db.exec(`
    BEGIN;
    CREATE VIRTUAL TABLE cases USING fts5(func, description, message, cwe, cve, tokenize = "unicode61 tokenchars '_'");
    CREATE TABLE vectors (line INTEGER PRIMARY KEY, embedding BLOB NOT NULL);
  `);
  const insert = db.prepare("INSERT INTO cases(rowid, func, description, message, cwe, cve) VALUES (?, ?, ?, ?, ?, ?)");
  await using source = await open(file);
  let line = 0;
  for await (const text of source.readLines()) {
    line++;
    if (!text.trim()) continue;
    try {
      const row = JSON.parse(text);
      if (typeof row.func !== "string" || !row.func.trim()) throw new Error("Expected function text.");
      if (typeof row.cve !== "string" || !row.cve.trim()) throw new Error("Expected a CVE identifier.");
      insert.run(line, row.func, row.cve_desc ?? "", row.commit_message ?? "", (row.cwe ?? []).join(" "), row.cve.trim());
    } catch (cause) {
      throw new Error(`${basename(file)} line ${line}: ${cause instanceof Error ? cause.message : cause}`, { cause });
    }
  }
  const count = await indexDescriptions(db);
  db.exec("COMMIT");
  return count;
}

const candidateCount = 20;

// Reciprocal rank fusion uses one-based ranks with k = 60.
function rankWeight(zeroBasedRank: number) {
  return 1 / (60 + zeroBasedRank + 1);
}

const fields = `rowid AS line, cve, cwe, substr(description, 1, 900) AS description`;

export async function searchCases(file: string, query: string): Promise<CaseSearch> {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]+(?:-[a-z0-9_]+)*/g) ?? [])].slice(0, 16);
  if (!terms.length) return { query, hits: [] };
  using db = new DatabaseSync(file, { readOnly: true });
  const ranked = db.prepare(`
    SELECT ${fields},
           CASE WHEN length(message) <= 800 THEN message
                ELSE substr(snippet(cases, 2, '', '', ' … ', 32), 1, 800) END AS commitMessage,
           substr(snippet(cases, 0, '', '', ' … ', 32), 1, 800) AS excerpt
    FROM cases WHERE cases MATCH ? ORDER BY rank, rowid
  `);
  const candidates = new Map<string, { hit: CaseHit; score: number }>();
  for (const row of ranked.iterate(terms.map(term => `"${term}"`).join(" OR "))) {
    const hit = row as CaseHit;
    if (candidates.has(hit.cve)) continue;
    candidates.set(hit.cve, { hit, score: rankWeight(candidates.size) });
    if (candidates.size === candidateCount) break;
  }

  const nearest = await nearestDescriptions(db, query, candidateCount);
  if (nearest.length) {
    const get = db.prepare(`SELECT ${fields}, substr(message, 1, 800) AS commitMessage,
      substr(func, 1, 800) AS excerpt FROM cases WHERE rowid = ?`);
    for (const [index, line] of nearest.entries()) {
      const hit = get.get(line) as CaseHit;
      const score = rankWeight(index);
      const lexical = candidates.get(hit.cve);
      if (lexical) lexical.score += score;
      else candidates.set(hit.cve, { hit, score });
    }
  }
  const hits = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 3).map(row => row.hit);
  return { query, hits };
}
