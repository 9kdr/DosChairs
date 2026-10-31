#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "schemas");
const fixtureDir = path.join(root, "fixtures");

const pairs = [
  ["timeline.schema.json", "timelines/empty.timeline.json"],
  ["changeset.schema.json", "timelines/example.changeset.json"],
  ["capability-manifest.schema.json", "presets/kdenlive.capabilities.json"],
  ["plan-muse-image.schema.json", "plans/muse-image.plan.json"],
  ["plan-sam-mask.schema.json", "plans/sam-mask.plan.json"],
  ["plan-grade.schema.json", "plans/grade.plan.json"],
  ["plan-motion.schema.json", "plans/motion.plan.json"],
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaNames = (await readdir(schemaDir)).filter((name) => name.endsWith(".schema.json"));
if (schemaNames.length === 0) {
  console.error("no schemas found");
  process.exit(1);
}

let failed = 0;
for (const [schemaName, fixtureRel] of pairs) {
  const schema = JSON.parse(await readFile(path.join(schemaDir, schemaName), "utf8"));
  const data = JSON.parse(await readFile(path.join(fixtureDir, fixtureRel), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    failed += 1;
    console.error(`FAIL ${fixtureRel} against ${schemaName}`);
    console.error(validate.errors);
  } else {
    console.log(`ok  ${fixtureRel}`);
  }
}

if (failed > 0) {
  process.exit(1);
}
