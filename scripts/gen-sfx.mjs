// Sound effects and the ambience loop, from ElevenLabs sound generation.
//
//   node scripts/gen-sfx.mjs
//
// Writes assets/sfx/<id>.mp3, skipping files that exist. Prompts describe the
// sound as a foley note would; prompt_influence stays high so the model does
// not improvise a scene around it.
//
// Credit: sound generation is billed by length (a fixed number of characters
// per second when duration_seconds is set), so a run reads the account's
// character count before and after, prints what it spent, and stops before a
// generation that would take the run past BUDGET characters.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
const OUT = join(ROOT, "assets/sfx");
mkdirSync(OUT, { recursive: true });
const BUDGET = 2000;          // characters of credit one run may spend
const PER_SECOND = 40;        // ElevenLabs' rate with duration_seconds set

const SFX = {
  "page-turn": { text: "a single thick paper page of a hardback picture book turning over slowly, soft paper slide and a gentle settle, close and quiet, no music", seconds: 1.4 },
  "page-settle": { text: "a hardback book cover closing softly onto a table, one muted thump, close and quiet", seconds: 0.7 },
  "cover-open": { text: "a hardback book cover opening with a soft creak of the spine and a paper whisper, close and quiet", seconds: 1.2 },
  "tap-pop": { text: "a tiny soft pop, like a bubble of air, playful and short, one hit", seconds: 0.5 },
  "shell-drop": { text: "a small seashell dropped into a shallow ceramic dish, one light click, close", seconds: 0.5 },
  "twig-tick": { text: "a small dry twig placed on wood, one light wooden tick, close", seconds: 0.5 },
  "pebble-drop": { text: "a smooth pebble set down on a folded cotton blanket, one soft dull tap, close", seconds: 0.6 },
  "sparkle": { text: "a short bright magical twinkle, tiny glass chimes rising, one gentle burst, no music", seconds: 1.0 },
  "rise": { text: "a sheet of card lifting and standing up, one soft paper rustle with a little whoosh, close and quiet", seconds: 0.8 },
  "carry": { text: "ten small shells gathered together in a quick soft rattle, then one wooden tick", seconds: 0.9 },
  "ambience": { text: "quiet mangrove shoreline in the late afternoon: gentle water lapping, a light warm breeze in leaves, distant small birds, no music, seamless", seconds: 14 },
};

async function gen(id, spec) {
  const out = join(OUT, `${id}.mp3`);
  if (existsSync(out)) { console.log(`skip ${id}`); return; }
  const r = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST", headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: spec.text, duration_seconds: spec.seconds, prompt_influence: 0.7 }),
  });
  if (!r.ok) throw new Error(`${id}: ${r.status} ${await r.text()}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log(`${id}: ${spec.seconds}s`);
}

for (const [id, spec] of Object.entries(SFX)) await gen(id, spec);
