// Audition three narrator voices on the opening spread so Shaab can pick one.
//
//   node scripts/audition.mjs
//
// Writes work/audition/<name>.mp3 and <name>.json (character timings) for each
// voice, skipping any take that already exists, and prints the quota before
// and after so the cost of the run is visible.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
const H = { "xi-api-key": KEY };

const VOICES = {
  sia: "gGNPBRoUZm1UG9WqGVlW",        // Sia, deep calm storytelling, female
  george: "JBFqnCBsd6RMkjVDRZzb",     // George, warm captivating storyteller, British
  bob: "ADiBuAJLjbCYBDa6dn3u",        // Bob Velvet, calm narrative, British
};
const MODEL = "eleven_multilingual_v2";
const SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true };

const text = JSON.parse(readFileSync(join(ROOT, "assets/text/01.json"), "utf8")).paragraphs.join("\n\n");
const out = join(ROOT, "work/audition");
mkdirSync(out, { recursive: true });

async function quota() {
  const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: H });
  const j = await r.json();
  return j.character_limit - j.character_count;
}

async function take(name, voice) {
  const mp3 = join(out, `${name}.mp3`);
  if (existsSync(mp3)) { console.log(`skip ${name} (exists)`); return; }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }),
  });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  writeFileSync(mp3, Buffer.from(j.audio_base64, "base64"));
  writeFileSync(join(out, `${name}.json`), JSON.stringify(j.alignment));
  const end = j.alignment.character_end_times_seconds.at(-1);
  console.log(`${name}: ${end.toFixed(2)} s`);
}

const before = await quota();
console.log(`text: ${text.length} chars\nquota before: ${before}`);
for (const [name, voice] of Object.entries(VOICES)) await take(name, voice);
console.log(`quota after: ${await quota()} (used ${before - (await quota())})`);
