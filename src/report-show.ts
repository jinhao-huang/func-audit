import { parseArgs } from "node:util";
import { readReport } from "./reports.ts";

const usage = "Usage: pnpm report:show --id <report-id>";

try {
  const { values } = parseArgs({
    options: { id: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(usage);
  } else {
    const id = Number(values.id);
    if (!values.id || !/^\d+$/.test(values.id) || !Number.isSafeInteger(id) || id < 1) {
      throw new Error(usage);
    }
    console.log(JSON.stringify(readReport(id), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
