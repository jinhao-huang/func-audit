import type { DatabaseSync } from "node:sqlite";

const model = "BAAI/bge-small-en-v1.5";
const dimensions = 384;
const revision = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

async function loadEncoder(localOnly: boolean) {
  const { pipeline } = await import("@huggingface/transformers");
  return pipeline("feature-extraction", model, {
    revision, cache_dir: "data/models", local_files_only: localOnly, device: "cpu", dtype: "fp32",
    session_options: { intraOpNumThreads: 4, interOpNumThreads: 1, executionMode: "sequential" },
  });
}

type Encoder = Awaited<ReturnType<typeof loadEncoder>>;

async function embed(encoder: Encoder, texts: string[]) {
  const tensor = await encoder(texts, { pooling: "cls", normalize: true });
  if (!(tensor.data instanceof Float32Array) || tensor.dims[0] !== texts.length || tensor.dims[1] !== dimensions) {
    throw new Error("Expected one 384-dimensional BGE Small vector per text.");
  }
  return tensor.data;
}

export async function indexDescriptions(db: DatabaseSync) {
  // In SQLite the description comes from the same row as the single MIN aggregate.
  const descriptions = db.prepare(`
    SELECT min(rowid) AS line, description FROM cases WHERE trim(description) <> '' GROUP BY cve
  `).all() as { line: number; description: string }[];
  if (descriptions.length) {
    // The prepare process downloads a public model without personal Hub credentials.
    delete process.env.HF_TOKEN;
    delete process.env.HF_ACCESS_TOKEN;
    const encoder = await loadEncoder(false);
    try {
      const save = db.prepare("INSERT INTO vectors VALUES (?, ?)");
      for (let i = 0; i < descriptions.length; i += 8) {
        const batch = descriptions.slice(i, i + 8);
        const data = await embed(encoder, batch.map(row => row.description));
        batch.forEach(({ line }, j) => save.run(line, data.subarray(j * dimensions, (j + 1) * dimensions)));
      }
    } finally {
      await encoder.dispose();
    }
  }
  return descriptions.length;
}

let queryEncoder: Promise<Encoder> | undefined;

export async function nearestDescriptions(db: DatabaseSync, query: string, limit: number) {
  const vectors = db.prepare("SELECT line, embedding FROM vectors ORDER BY line").all();
  if (!vectors.length) return [];
  queryEncoder ??= loadEncoder(true);
  const target = await embed(await queryEncoder, [`Represent this sentence for searching relevant passages: ${query}`]);
  return vectors.map(row => {
    const blob = row.embedding as Uint8Array;
    const vector = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    let similarity = 0;
    for (let i = 0; i < target.length; i++) similarity += target[i] * vector[i];
    return { line: Number(row.line), similarity };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, limit).map(row => row.line);
}
