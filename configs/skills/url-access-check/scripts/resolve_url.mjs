import process from "node:process";
import { URL } from "node:url";

const [base, location] = process.argv.slice(2);
if (!base || !location) {
  process.exit(2);
}

try {
  const resolved = new URL(location, base);
  process.stdout.write(resolved.toString());
} catch {
  process.exit(1);
}
