// Narration for every spread, one take each, with word timings folded from
// ElevenLabs' character timestamps.
//
//   node scripts/gen-audio.mjs              generate what is missing
//   node scripts/gen-audio.mjs --check      validate the timing files only
//   node scripts/gen-audio.mjs --only 04    one spread
//
// Writes assets/audio/spread-NN.mp3 and assets/timings/spread-NN.json, plus
// assets/audio/title.mp3 for the title spread. A take that already exists is
// skipped, so a rerun is free; delete a file to regenerate it. The quota is
// printed before and after so the cost of a run is visible (the counter can
// lag by a few minutes).
//
// Word timings come from the with-timestamps endpoint: it returns one start
// and end per character of the request text, so folding runs of non-space
// characters gives one entry per whitespace token, which is exactly how the
// story card tokenises the same text. Starts are pulled 40 ms early, which is
// what lands a highlight on the word rather than a beat behind it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.ELEVENLABS_API_KEY;
const H = { "xi-api-key": KEY };
const AUDIO = join(ROOT, "assets/audio");
const TIMINGS = join(ROOT, "assets/timings");
const TEXT = join(ROOT, "assets/text");

const VOICE = process.env.SB_VOICE || "iCrDUkL56s3C8sCRl7wb"; // Hope, chosen by Shaab from six auditions on 15 Sept 2026
const MODEL = "eleven_multilingual_v2";
// speed 0.85 brings Hope from about 182 to about 155 words a minute, the pace of
// a read-aloud rather than an audiobook; the first full take was too brisk.
const SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 0.85 };
const LEAD_S = 0.04;

const STORY = Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, "0"));
const TITLE_LINE = "Spring Bloom. A math adventure story, by Sadia Mir and Summer Al-Jarrah Bateiha, illustrated by Inna Ogando.";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const checkOnly = args.includes("--check");

function spreadText(id) {
  return JSON.parse(readFileSync(join(TEXT, `${id}.json`), "utf8")).paragraphs.join("\n\n");
}

function foldWords(alignment) {
  const chars = alignment.characters, starts = alignment.character_start_times_seconds, ends = alignment.character_end_times_seconds;
  const words = [];
  let cur = null;
  chars.forEach((c, i) => {
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { text: c, start: starts[i], end: ends[i] };
    else { cur.text += c; cur.end = ends[i]; }
  });
  if (cur) words.push(cur);
  let prevEnd = 0;
  return words.map((w, i) => {
    const start = Math.max(prevEnd, w.start - LEAD_S);
    prevEnd = w.end;
    return { i, text: w.text, start: +start.toFixed(3), end: +w.end.toFixed(3) };
  });
}

async function quota() {
  const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: H });
  const j = await r.json();
  return j.character_limit - j.character_count;
}

async function synth(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function take(id, text, mp3, timings) {
  if (existsSync(mp3) && existsSync(timings)) { console.log(`skip ${id} (exists)`); return; }
  const j = await synth(text);
  writeFileSync(mp3, Buffer.from(j.audio_base64, "base64"));
  const words = foldWords(j.alignment);
  const expected = text.split(/\s+/).filter(Boolean);
  if (words.length !== expected.length) throw new Error(`${id}: folded ${words.length} words, card has ${expected.length}`);
  writeFileSync(timings, JSON.stringify({ id, voice: VOICE, model: MODEL, duration: words.at(-1).end, words }, null, 1));
  console.log(`${id}: ${words.length} words, ${words.at(-1).end.toFixed(2)} s`);
}

function check() {
  let ok = true;
  for (const id of STORY) {
    const p = join(TIMINGS, `spread-${id}.json`);
    if (!existsSync(p)) { console.log(`missing ${p}`); ok = false; continue; }
    const t = JSON.parse(readFileSync(p, "utf8"));
    const expected = spreadText(id).split(/\s+/).filter(Boolean);
    const texts = t.words.map((w) => w.text);
    if (texts.length !== expected.length) { console.log(`${id}: ${texts.length} timed words vs ${expected.length} card words`); ok = false; }
    for (let i = 1; i < t.words.length; i++) {
      if (t.words[i].start < t.words[i - 1].start || t.words[i].end <= t.words[i].start) { console.log(`${id}: word ${i} not monotonic`); ok = false; break; }
    }
    if (!existsSync(join(AUDIO, `spread-${id}.mp3`))) { console.log(`${id}: mp3 missing`); ok = false; }
  }
  console.log(ok ? "OK" : "MISMATCH");
  process.exit(ok ? 0 : 1);
}

if (checkOnly) check();
else {
  if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
  mkdirSync(AUDIO, { recursive: true }); mkdirSync(TIMINGS, { recursive: true });
  const before = await quota();
  console.log(`voice ${VOICE}, quota before: ${before}`);
  for (const id of STORY) {
    if (only && only !== id) continue;
    await take(id, spreadText(id), join(AUDIO, `spread-${id}.mp3`), join(TIMINGS, `spread-${id}.json`));
  }
  if (!only) await take("title", TITLE_LINE, join(AUDIO, "title.mp3"), join(TIMINGS, "title.json"));
  console.log(`quota after: ${await quota()} (before ${before})`);
}
