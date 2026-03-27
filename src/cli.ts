#!/usr/bin/env bun

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.log("cli-lane");
  process.exit(0);
}

console.error("Unsupported arguments");
process.exit(1);
