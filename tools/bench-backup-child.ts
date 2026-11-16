// The copy of tools/bench-backup.ts in a process of its own, as the app runs it (ADR 0145).
import { closeSync, openSync } from "node:fs";
import { copyDatabase } from "../packages/adapter-sqlite/src/backup.ts";

const [source, target] = process.argv.slice(2) as [string, string];
closeSync(openSync(target, "wx", 0o600));
copyDatabase(source, target);
console.log(JSON.stringify({ peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
