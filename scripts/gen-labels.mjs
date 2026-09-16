// One short spoken clip per tappable layer name, in the narrator's voice, so
// tapping the camel says "the camel" even where the story never says it.
//
//   node scripts/gen-labels.mjs
//
// Names come from tools/masks/*.json; clips land in assets/audio/labels/<slug>.mp3
// and existing clips are skipped.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
const VOICE = process.env.SB_VOICE || "iCrDUkL56s3C8sCRl7wb";
const OUT = join(ROOT, "assets/audio/labels");
mkdirSync(OUT, { recursive: true });

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const names = new Set();
for (const f of readdirSync(join(ROOT, "tools/masks"))) {
  if (!f.endsWith(".json")) continue;
  for (const l of JSON.parse(readFileSync(join(ROOT, "tools/masks", f), "utf8")).layers) names.add(l.name);
}
let chars = 0;
for (const name of [...names].sort()) {
  const out = join(OUT, `${slug(name)}.mp3`);
  if (existsSync(out)) continue;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: name + ".", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  chars += name.length + 1;
  console.log(`${slug(name)}`);
}
console.log(`${names.size} names, ${chars} characters generated`);
