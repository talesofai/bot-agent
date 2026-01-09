import { serve } from "bun";

console.log("Hello via Bun!");

// Simple placeholder server - keeping fastify in dependencies for later robust usage,
// but for now verifying Bun runtime.
console.log("Environment check:", {
  NODE_ENV: process.env.NODE_ENV,
  BUN_VERSION: Bun.version
});
