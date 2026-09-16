// The music bed, one take from ElevenLabs Music.
//
//   node scripts/gen-music.mjs
//
// Writes assets/bed/bed.mp3 (skipped if it exists). The tempo is stated more
// than once because the model honours a repeated constraint better than a
// stated one, and the take is longer than the reel so the mix has a tail to
// fade. Quota is printed before and after; the counter can lag.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
const OUT = join(ROOT, "assets/bed/bed.mp3");
mkdirSync(join(ROOT, "assets/bed"), { recursive: true });

const PROMPT = "Gentle warm instrumental bed for a children's picture book being read aloud at a picnic in the desert mangroves. Soft nylon-string guitar, kalimba and a quiet oud, light shaker, slow at 72 BPM, sunny and calm, 72 BPM, no vocals, no drums, no big changes, even and loopable, 72 BPM throughout.";

async function quota() {
  const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": KEY } });
  const j = await r.json();
  return j.character_limit - j.character_count;
}

if (existsSync(OUT)) { console.log("skip bed (exists)"); process.exit(0); }
const before = await quota();
const r = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
  method: "POST", headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: PROMPT, music_length_ms: 90000 }),
});
if (!r.ok) throw new Error(`music: ${r.status} ${await r.text()}`);
writeFileSync(OUT, Buffer.from(await r.arrayBuffer()));
console.log(`bed written; quota before ${before}, after ${await quota()}`);
