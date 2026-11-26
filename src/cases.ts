import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CaseHit = {
  line: number;
  cve: string;
  cwe: string;
  description: string;
  commitMessage: string;
  excerpt: string;
};
export type CaseSearch = { query: string; hits: CaseHit[] };

function refreshIndex(db: DatabaseSync, file: string, stamp: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS corpus (stamp TEXT NOT NULL)");
    if (!db.prepare("SELECT 1 FROM corpus WHERE stamp = ?").get(stamp)) {
      db.exec(`
        DROP TABLE IF EXISTS cases;
        CREATE VIRTUAL TABLE cases USING fts5(
          func, description, message, cwe, cve, tokenize = "unicode61 tokenchars '_'"
        );
      `);
      const insert = db.prepare("INSERT INTO cases(rowid, func, description, message, cwe, cve) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row.func !== "string" || !row.func.trim()) throw new Error("Expected function text.");
          if (typeof row.cve !== "string" || !row.cve.trim()) throw new Error("Expected a CVE identifier.");
          insert.run(index + 1, row.func, row.cve_desc ?? "", row.commit_message ?? "",
            (row.cwe ?? []).join(" "), row.cve.trim());
        } catch (cause) {
          throw new Error(`${basename(file)} line ${index + 1}: ${cause instanceof Error ? cause.message : cause}`, { cause });
        }
      }
      db.exec("DELETE FROM corpus");
      db.prepare("INSERT INTO corpus VALUES (?)").run(stamp);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function searchCases(file: string, query: string): CaseSearch {
  const info = statSync(file, { bigint: true });
  using db = new DatabaseSync(`${file}.sqlite`, { timeout: 30000 });
  db.exec("PRAGMA journal_mode=WAL");
  refreshIndex(db, file, `${info.size}:${info.mtimeNs}`);
  const ranked = db.prepare(`
    SELECT rowid, cve, cwe, substr(description, 1, 900) AS description,
           CASE WHEN length(message) <= 800 THEN message
                ELSE substr(snippet(cases, 2, '', '', ' … ', 32), 1, 800) END AS commitMessage,
           substr(snippet(cases, 0, '', '', ' … ', 32), 1, 800) AS excerpt
    FROM cases WHERE cases MATCH ? ORDER BY rank, rowid
  `);
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]+(?:-[a-z0-9_]+)*/g) ?? [])].slice(0, 16);
  const hits: CaseHit[] = [];
  if (terms.length) {
    const cves = new Set<string>();
    for (const row of ranked.iterate(terms.map((term) => `"${term}"`).join(" OR "))) {
      const cve = String(row.cve);
      if (cves.has(cve)) continue;
      cves.add(cve);
      hits.push({ line: Number(row.rowid), cve, cwe: String(row.cwe),
        description: String(row.description), commitMessage: String(row.commitMessage), excerpt: String(row.excerpt) });
      if (hits.length === 3) break;
    }
  }
  return { query, hits };
}
