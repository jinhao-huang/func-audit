import { loadPairs } from "../../src/samples.ts";

export async function loader() {
  try {
    const pairs = await loadPairs("all");
    return { ids: pairs.map(pair => pair.samples.map(sample => sample.idx)), error: null };
  } catch (error) {
    return { ids: [], error: (error as Error).message };
  }
}
