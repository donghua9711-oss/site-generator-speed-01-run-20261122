// The harness driver for the make.fun bounty
// "site-generator-speed-01-run-20261122": read every case from
// /input/cases.json, answer each one with solve.js's run, and
// write the answers, one per case and in the cases' order, to
// /output/answers.json. Outside a container, MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The speed lives in solve.js; this file only moves JSON in and
// out. V8's incremental marking is switched off before solve.js
// is imported, so all of its work runs under that setting, as the
// house baseline's driver does (the rules allow an entry to tune
// V8's flags).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";

setFlagsFromString("--no-incremental-marking");

const { run } = (await import(new URL("./solve.js", import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8")) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(outputDir, "answers.json"), JSON.stringify(answers));
