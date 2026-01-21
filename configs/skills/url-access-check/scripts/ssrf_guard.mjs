import process from "node:process";

import { checkSsrfUrl } from "./ssrf.mjs";

const input = process.argv[2];
if (!input) {
  process.stdout.write("missing_url\n");
  process.exit(2);
}

const result = await checkSsrfUrl(input, { env: process.env });
if (result.allowed) {
  process.exit(0);
}

process.stdout.write(`${result.reason ?? "ssrf_blocked"}\n`);
process.exit(1);
