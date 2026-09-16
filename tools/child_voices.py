"""Children's voices for Zade and Aliya: their quoted lines spoken by child
voices, spliced into Hope's narration takes, with the word timings rebuilt.

    python tools/child_voices.py plan                 the quotes, who says them, token ranges (no API)
    python tools/child_voices.py add ROLE OWNER VOICE  add a library voice to the account under a Spring Bloom name
    python tools/child_voices.py audition ROLE NAME VOICE_ID   60-character sample -> work/audition/ROLE-NAME.mp3
    python tools/child_voices.py generate [--only NN]  one clip per Zade/Aliya quote -> work/dialogue/NN-qK.mp3/.json (cached)
    python tools/child_voices.py build [--only NN]     splice: work/narration-hope (the originals) + clips -> assets/audio + assets/timings
    python tools/child_voices.py verify                word lists, monotonic timings, durations, decoded-mp3 alignment

The narrator's words keep Hope's audio: the CURRENT take is sliced by its CURRENT
timings, a little before the first word of each run to a little after its last,
and the child clip goes in place of the quote with GAP seconds of silence either
side and a short fade at every cut. Narrator words shift with their slice; child
words take the clip's own timings offset by where the clip landed. The first
build copies the Hope originals to work/narration-hope/ and every later build
reads from there, so a rebuild is idempotent and the whole thing is reversible
by copying those files back.

Speakers come from assets/data/speakers.json (one keyword per quote, in text
order); only "zade" and "aliya" get a child voice, every other quote stays with
Hope. Quotes are the runs between curly quotes in the spread's paragraphs.
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
AUDIO = os.path.join(ROOT, "assets", "audio")
TIMINGS = os.path.join(ROOT, "assets", "timings")
TEXT = os.path.join(ROOT, "assets", "text")
SPEAKERS = os.path.join(ROOT, "assets", "data", "speakers.json")
WORK = os.path.join(ROOT, "work")
DIALOGUE = os.path.join(WORK, "dialogue")
BACKUP = os.path.join(WORK, "narration-hope")
AUDITION = os.path.join(WORK, "audition")

KEY = os.environ.get("ELEVENLABS_API_KEY")
API = "https://api.elevenlabs.io/v1"
HOPE = "iCrDUkL56s3C8sCRl7wb"
MODEL = "eleven_multilingual_v2"
CHILD_ROLES = ("zade", "aliya")

# The two children. Chosen on 16 Sept 2026 from the shared voice library; see work/VOICES.md.
VOICES = {
    "zade": {"id": os.environ.get("SB_ZADE", "loY1uopAz31XyhAEhNSa"), "name": "Valf - Young, Playful & Sarcastic"},
    "aliya": {"id": os.environ.get("SB_ALIYA", "Pt5YrLNyu6d2s3s4CVMg"), "name": "Lily - Soft, Cute and Sweet"},
}
# speed 0.9 sits just above Hope's 0.85: children read a touch quicker than the narrator
SETTINGS = {"stability": 0.5, "similarity_boost": 0.75, "style": 0.25, "use_speaker_boost": True, "speed": 0.9}

SR = 44100
LEAD_S = 0.04     # starts pulled early, as gen-audio.mjs does
GAP = 0.18        # silence either side of a splice
PRE = 0.15        # narrator slice starts this long before its first word (when the take allows)
POST = 0.15       # and ends this long after its last word
FADE = 0.012      # seconds of linear fade at every cut
CLIP_HEAD = 0.08  # child clip keeps this much of its own lead-in
CLIP_TAIL = 0.12  # and this much after its last word
END_TAIL = 0.15   # silence after a child clip that ends a take
STORY = [f"{i:02d}" for i in range(1, 16)]

# ---------------------------------------------------------------- text --------

def spread_text(sid):
    with open(os.path.join(TEXT, f"{sid}.json"), encoding="utf-8") as f:
        return "\n\n".join(json.load(f)["paragraphs"])

def tokens_of(text):
    return [(m.group(0), m.start(), m.end()) for m in re.finditer(r"\S+", text)]

def quotes_of(sid):
    """Every quote of a spread: index, speaker, inner text, token range [a, b]."""
    text = spread_text(sid)
    toks = tokens_of(text)
    with open(SPEAKERS, encoding="utf-8") as f:
        speakers = json.load(f).get(sid, [])
    qs = list(re.finditer(r"“([^”]*)”", text))
    if len(qs) != len(speakers):
        raise SystemExit(f"{sid}: {len(qs)} quotes in the text, {len(speakers)} speakers listed")
    out = []
    for k, (m, who) in enumerate(zip(qs, speakers)):
        s, e = m.start(), m.end()
        a = next(i for i, t in enumerate(toks) if t[2] > s)
        b = max(i for i, t in enumerate(toks) if t[1] < e)
        if toks[a][1] > s or toks[b][2] < e:
            raise SystemExit(f"{sid} q{k}: quote does not sit on token boundaries")
        inner = m.group(1).strip()
        if len(inner.split()) != b - a + 1:
            raise SystemExit(f"{sid} q{k}: inner text has {len(inner.split())} tokens, range covers {b - a + 1}")
        out.append({"k": k, "speaker": who, "text": inner, "a": a, "b": b, "child": who in CHILD_ROLES})
    return toks, out

def items_of(n, quotes):
    """Narrator runs and child quotes, in text order."""
    child = {q["a"]: q for q in quotes if q["child"]}
    items, i = [], 0
    while i < n:
        if i in child:
            q = child[i]
            items.append({"type": "child", "q": q, "a": q["a"], "b": q["b"]})
            i = q["b"] + 1
            continue
        j = i
        while j + 1 < n and (j + 1) not in child:
            j += 1
        items.append({"type": "narrator", "a": i, "b": j})
        i = j + 1
    return items

def spreads_with_children():
    out = []
    for sid in STORY:
        _, qs = quotes_of(sid)
        if any(q["child"] for q in qs):
            out.append(sid)
    return out

# ---------------------------------------------------------------- api ---------

def api(method, path, body=None, timeout=120):
    if not KEY:
        raise SystemExit("ELEVENLABS_API_KEY is not set")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"xi-api-key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def quota():
    j = api("GET", "/user/subscription")
    return j["character_limit"] - j["character_count"]

def synth(voice, text, settings=SETTINGS):
    return api("POST", f"/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128",
               {"text": text, "model_id": MODEL, "voice_settings": settings})

def fold_words(al):
    chars, starts, ends = al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]
    words, cur = [], None
    for c, s, e in zip(chars, starts, ends):
        if c.isspace():
            if cur:
                words.append(cur); cur = None
            continue
        if cur is None:
            cur = {"text": c, "start": s, "end": e}
        else:
            cur["text"] += c; cur["end"] = e
    if cur:
        words.append(cur)
    prev_end, out = 0.0, []
    for i, w in enumerate(words):
        start = max(prev_end, w["start"] - LEAD_S)
        prev_end = w["end"]
        out.append({"i": i, "text": w["text"], "start": round(start, 3), "end": round(w["end"], 3), "raw_start": w["start"]})
    return out

def take(voice, text, mp3, meta, extra):
    """One with-timestamps call, cached on disk."""
    if os.path.exists(mp3) and os.path.exists(meta):
        return None
    j = synth(voice, text)
    audio = __import__("base64").b64decode(j["audio_base64"])
    with open(mp3, "wb") as f:
        f.write(audio)
    words = fold_words(j["alignment"])
    expected = text.split()
    if [w["text"] for w in words] != expected:
        raise SystemExit(f"{mp3}: folded {[w['text'] for w in words]} vs text {expected}")
    dur = probe_duration(mp3)
    rec = {**extra, "voice": voice, "model": MODEL, "settings": SETTINGS, "text": text, "chars": len(text),
           "duration": dur, "words": [{k: v for k, v in w.items() if k != "raw_start"} for w in words],
           "raw": {"first_start": words[0]["raw_start"], "last_end": words[-1]["end"]}, "alignment": j["alignment"]}
    with open(meta, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=1, ensure_ascii=False)
    return rec

# ---------------------------------------------------------------- audio -------

def probe_duration(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(p.stdout.strip())

def decode(path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"ffmpeg decode failed for {path}: {p.stderr.decode(errors='replace')}")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()

def encode(y, path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                        "-codec:a", "libmp3lame", "-b:a", "128k", "-ar", str(SR), "-ac", "1", path],
                       input=y.astype(np.float32).tobytes(), capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"ffmpeg encode failed for {path}: {p.stderr.decode(errors='replace')}")

def speech_rms(x):
    """Median RMS of the louder half of 50 ms frames: the level of the voice, not the pauses."""
    n = int(0.05 * SR)
    frames = x[: len(x) // n * n].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    loud = rms[rms > 0.2 * rms.max()]
    return float(np.median(loud)) if len(loud) else float(rms.max())

def _k_weight(x):
    """ITU-R BS.1770 K-weighting at 44.1 kHz: the high shelf then the high-pass."""
    from scipy.signal import lfilter
    # coefficients from the standard's 48 kHz table, re-derived for 44.1 kHz (libebur128's formulas)
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / SR); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    y = lfilter(b, a, x)
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / SR)
    a0 = 1 + K / Q + K * K
    b = [1, -2, 1]; a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    b = [v / a0 for v in b]
    return lfilter(b, a, y)

def lufs(x):
    """Integrated loudness (mono, BS.1770-4 gating): 400 ms blocks every 100 ms, an
    absolute gate at -70 LUFS and a relative gate 10 LU under the ungated mean.
    Duration-independent, so a one-word clip and a forty-second take compare."""
    z = _k_weight(x.astype(np.float64)) ** 2
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    if len(z) < blk:
        z = np.concatenate([z, np.zeros(blk - len(z))])
    c = np.concatenate([[0.0], np.cumsum(z)])
    starts = np.arange(0, len(z) - blk + 1, hop)
    means = (c[starts + blk] - c[starts]) / blk
    l = -0.691 + 10 * np.log10(np.maximum(means, 1e-12))
    keep = l > -70
    if not keep.any():
        return -70.0
    rel = -0.691 + 10 * np.log10(means[keep].mean()) - 10
    keep &= l > rel
    return float(-0.691 + 10 * np.log10(means[keep].mean()))

def loud_level(x):
    """The level of the loud third of 100 ms K-weighted blocks, in dB. Integrated
    loudness dilutes a half-second word with the silence inside its 400 ms
    blocks; this matches the loud syllables of a clip to the loud syllables of
    the take and gives the same answer for one word or forty seconds."""
    z = _k_weight(x.astype(np.float64)) ** 2
    blk, hop = int(0.1 * SR), int(0.05 * SR)
    if len(z) < blk:
        z = np.concatenate([z, np.zeros(blk - len(z))])
    c = np.concatenate([[0.0], np.cumsum(z)])
    starts = np.arange(0, len(z) - blk + 1, hop)
    means = (c[starts + blk] - c[starts]) / blk
    means = means[means > 1e-7]
    if not len(means):
        return -70.0
    top = np.sort(means)[int(len(means) * 0.67):]
    return float(-0.691 + 10 * np.log10(top.mean()))

def fade(seg, head=True, tail=True):
    seg = seg.copy()
    n = min(int(FADE * SR), len(seg) // 2)
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        if head:
            seg[:n] *= ramp
        if tail:
            seg[-n:] *= ramp[::-1]
    return seg

def silence(seconds):
    return np.zeros(int(round(seconds * SR)), dtype=np.float32)

def sound_bounds(c):
    """Where a clip's sound starts and stops, in seconds: the first and last 10 ms
    frame above a tenth of the voice level (with a floor), because the alignment
    reports the first character at 0 even when the clip opens with silence and
    lets the last word run to the end of the file through the trailing silence."""
    n = int(0.01 * SR)
    frames = c[: len(c) // n * n].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    level = speech_rms(c)
    on = np.where(rms > max(0.004, 0.1 * level))[0]
    off = np.where(rms > max(0.004, 0.05 * level))[0]
    if not len(on) or not len(off):
        return 0.0, len(c) / SR
    return on[0] * n / SR, (off[-1] + 1) * n / SR

# ---------------------------------------------------------------- commands ----

def cmd_plan():
    total = 0
    for sid in STORY:
        toks, qs = quotes_of(sid)
        if not any(q["child"] for q in qs):
            continue
        print(f"== spread {sid}: {len(toks)} tokens")
        for it in items_of(len(toks), qs):
            if it["type"] == "narrator":
                print(f"   narrator  {it['a']:3d}-{it['b']:3d}")
            else:
                q = it["q"]; total += len(q["text"])
                print(f"   {q['speaker']:9s} {q['a']:3d}-{q['b']:3d}  q{q['k']} ({len(q['text'])} chars): {q['text']}")
    print(f"child characters: {total}")

def cmd_add(role, owner, voice_id):
    name = f"{role.capitalize()} (Spring Bloom)"
    j = api("POST", f"/voices/add/{owner}/{voice_id}", {"new_name": name})
    print(json.dumps(j))

def cmd_audition(role, name, voice_id):
    os.makedirs(AUDITION, exist_ok=True)
    line = {
        "zade": "Hello there, can we have the first riddle for the party?",
        "aliya": "Let's try. We need to count how many mangrove trees we see.",
    }[role]
    mp3 = os.path.join(AUDITION, f"{role}-{name}.mp3")
    meta = os.path.join(AUDITION, f"{role}-{name}.json")
    before = quota()
    rec = take(voice_id, line, mp3, meta, {"role": role, "name": name})
    print(f"{role}-{name}: {'cached' if rec is None else f'{rec[chr(100)+chr(117)+chr(114)+chr(97)+chr(116)+chr(105)+chr(111)+chr(110)]:.2f} s'}, {len(line)} chars, quota {before} -> {quota()}")

def cmd_generate(only=None):
    os.makedirs(DIALOGUE, exist_ok=True)
    for role in CHILD_ROLES:
        if not VOICES[role]["id"]:
            raise SystemExit(f"no voice id for {role}: set SB_{role.upper()} or edit VOICES")
    before = quota()
    spent = 0
    print(f"quota before: {before}")
    for sid in spreads_with_children():
        if only and only != sid:
            continue
        _, qs = quotes_of(sid)
        for q in qs:
            if not q["child"]:
                continue
            mp3 = os.path.join(DIALOGUE, f"{sid}-q{q['k']}.mp3")
            meta = os.path.join(DIALOGUE, f"{sid}-q{q['k']}.json")
            rec = take(VOICES[q["speaker"]]["id"], q["text"], mp3, meta,
                       {"spread": sid, "quote": q["k"], "speaker": q["speaker"], "tokens": [q["a"], q["b"]]})
            if rec is None:
                print(f"  {sid}-q{q['k']} cached")
            else:
                spent += len(q["text"])
                print(f"  {sid}-q{q['k']} {q['speaker']:5s} {rec['duration']:.2f} s  {q['text']}")
    after = quota()
    print(f"characters sent this run: {spent}; quota after: {after} (used {before - after})")

def source_take(sid):
    """The Hope original, backed up on first use."""
    os.makedirs(BACKUP, exist_ok=True)
    bmp3 = os.path.join(BACKUP, f"spread-{sid}.mp3")
    bjson = os.path.join(BACKUP, f"spread-{sid}.json")
    if not (os.path.exists(bmp3) and os.path.exists(bjson)):
        with open(os.path.join(TIMINGS, f"spread-{sid}.json"), encoding="utf-8") as f:
            cur = json.load(f)
        if cur.get("voice") != HOPE:
            raise SystemExit(f"{sid}: assets take is voice {cur.get('voice')!r}, refusing to treat it as the Hope original")
        shutil.copy2(os.path.join(AUDIO, f"spread-{sid}.mp3"), bmp3)
        shutil.copy2(os.path.join(TIMINGS, f"spread-{sid}.json"), bjson)
    with open(bjson, encoding="utf-8") as f:
        return bmp3, json.load(f)

def build_spread(sid):
    toks, qs = quotes_of(sid)
    n = len(toks)
    src_mp3, old = source_take(sid)
    W = old["words"]
    if len(W) != n or [w["text"] for w in W] != [t[0] for t in toks]:
        raise SystemExit(f"{sid}: original timings do not match the card text")
    x = decode(src_mp3)
    old_dur = len(x) / SR
    hope_loud = loud_level(x)
    parts, t, new = [], 0.0, [None] * n
    items = items_of(n, qs)
    used = {}
    splices = []
    for idx, it in enumerate(items):
        first, last = idx == 0, idx == len(items) - 1
        if parts:
            parts.append(silence(GAP)); t += GAP
        if it["type"] == "narrator":
            i, j = it["a"], it["b"]
            s0 = 0.0 if i == 0 else min(max(W[i - 1]["end"] + 0.03, W[i]["start"] - PRE), W[i]["start"])
            e0 = old_dur if j == n - 1 else max(min(W[j + 1]["start"] - 0.03, W[j]["end"] + POST), W[j]["end"])
            seg = fade(x[int(round(s0 * SR)): int(round(e0 * SR))], head=s0 > 0, tail=e0 < old_dur)
            for k in range(i, j + 1):
                new[k] = {"i": k, "text": W[k]["text"], "start": W[k]["start"] - s0 + t, "end": W[k]["end"] - s0 + t}
            parts.append(seg); t += len(seg) / SR
        else:
            q = it["q"]
            meta = os.path.join(DIALOGUE, f"{sid}-q{q['k']}.json")
            mp3 = os.path.join(DIALOGUE, f"{sid}-q{q['k']}.mp3")
            with open(meta, encoding="utf-8") as f:
                rec = json.load(f)
            if rec["text"] != q["text"] or rec["speaker"] != q["speaker"]:
                raise SystemExit(f"{sid}-q{q['k']}: cached clip is for different text or speaker; delete it and regenerate")
            c = decode(mp3)
            cdur = len(c) / SR
            onset, offset = sound_bounds(c)
            cw = [dict(w) for w in rec["words"]]
            cw[0]["start"] = max(cw[0]["start"], min(onset - LEAD_S, cw[0]["end"] - 0.05))
            cw[-1]["end"] = max(min(cw[-1]["end"], offset + 0.03), cw[-1]["start"] + 0.05)
            c0 = min(max(0.0, onset - CLIP_HEAD), cw[0]["start"])
            c1 = max(min(cdur, offset + CLIP_TAIL), cw[-1]["end"])
            seg = c[int(round(c0 * SR)): int(round(c1 * SR))]
            # the child's loud syllables sit at the level of the narrator's, K-weighted
            gain = min(3.0, max(0.1, 10 ** ((hope_loud - loud_level(seg)) / 20)))
            seg = seg * gain
            splices.append({"quote": q["k"], "speaker": q["speaker"], "tokens": [q["a"], q["b"]], "gain_db": round(20 * np.log10(gain), 1)})
            peak = float(np.abs(seg).max()) if len(seg) else 0.0
            if peak > 0.97:
                seg = seg * (0.97 / peak)
            seg = fade(seg, head=True, tail=True)
            for m, w in enumerate(cw):
                k = q["a"] + m
                if w["text"] != toks[k][0].strip("“”"):
                    raise SystemExit(f"{sid}-q{q['k']}: clip word {w['text']!r} vs card token {toks[k][0]!r}")
                new[k] = {"i": k, "text": toks[k][0], "start": w["start"] - c0 + t, "end": w["end"] - c0 + t}
            parts.append(seg); t += len(seg) / SR
            used[q["speaker"]] = rec["voice"]
            if last:
                parts.append(silence(END_TAIL)); t += END_TAIL
    y = np.concatenate(parts)
    duration = len(y) / SR
    prev_end = 0.0
    for w in new:
        w["start"] = round(max(prev_end, w["start"]), 3)
        w["end"] = round(min(duration, w["end"]), 3)
        prev_end = w["end"]
    out_mp3 = os.path.join(AUDIO, f"spread-{sid}.mp3")
    out_json = os.path.join(TIMINGS, f"spread-{sid}.json")
    encode(y, out_mp3)
    rec = {"id": sid, "voice": "hope+children", "model": MODEL, "duration": round(duration, 3), "words": new,
           "voices": {"narrator": HOPE, **used}, "splices": splices, "built": time.strftime("%Y-%m-%d %H:%M")}
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=1, ensure_ascii=False)
    print(f"{sid}: {old_dur:.2f} s -> {duration:.2f} s, {sum(1 for it in items if it['type'] == 'child')} child quotes, {len(items)} segments")

def cmd_build(only=None):
    for sid in spreads_with_children():
        if only and only != sid:
            continue
        build_spread(sid)

def cmd_verify():
    ok = True
    for sid in spreads_with_children():
        bjson = os.path.join(BACKUP, f"spread-{sid}.json")
        if not os.path.exists(bjson):
            print(f"{sid}: not rebuilt yet"); continue
        with open(bjson, encoding="utf-8") as f:
            old = json.load(f)
        with open(os.path.join(TIMINGS, f"spread-{sid}.json"), encoding="utf-8") as f:
            cur = json.load(f)
        probs = []
        if [w["text"] for w in old["words"]] != [w["text"] for w in cur["words"]]:
            probs.append("word list differs from the original")
        if [w["text"] for w in cur["words"]] != spread_text(sid).split():
            probs.append("word list differs from the card text")
        for i, w in enumerate(cur["words"]):
            if w["i"] != i: probs.append(f"word {i} has i={w['i']}"); break
            if w["end"] <= w["start"]: probs.append(f"word {i} end <= start"); break
            if i and w["start"] < cur["words"][i - 1]["start"]: probs.append(f"word {i} not monotonic"); break
            if i and w["start"] < cur["words"][i - 1]["end"] - 1e-6: probs.append(f"word {i} overlaps previous"); break
            if w["end"] > cur["duration"] + 1e-6: probs.append(f"word {i} ends after duration"); break
        mp3 = os.path.join(AUDIO, f"spread-{sid}.mp3")
        adur = probe_duration(mp3)
        if abs(adur - cur["duration"]) > 0.1:
            probs.append(f"audio {adur:.3f} s vs duration {cur['duration']:.3f}")
        y = decode(mp3)
        if abs(len(y) / SR - cur["duration"]) > 0.05:
            probs.append(f"decoded {len(y) / SR:.3f} s vs duration {cur['duration']:.3f}")
        # every child word must have sound somewhere in its span, and the span must not be mostly silence
        quiet = []
        _, qs = quotes_of(sid)
        n10 = int(0.01 * SR)
        for q in qs:
            if not q["child"]: continue
            for k in range(q["a"], q["b"] + 1):
                w = cur["words"][k]
                seg = y[int(w["start"] * SR): int(w["end"] * SR)]
                fr = seg[: len(seg) // n10 * n10].reshape(-1, n10) if len(seg) >= n10 else np.zeros((0, n10), dtype=np.float32)
                act = np.sqrt((fr ** 2).mean(axis=1)) > 0.004 if len(fr) else np.zeros(0, dtype=bool)
                if not len(act) or act.mean() < 0.3: quiet.append(w["text"])
        if quiet: probs.append(f"child words mostly silent: {quiet}")
        status = "ok" if not probs else "PROBLEM: " + "; ".join(probs)
        if probs: ok = False
        print(f"{sid}: {len(cur['words'])} words, {cur['duration']:.2f} s (was {old['duration']:.2f}), audio {adur:.2f} s: {status}")
    print("OK" if ok else "MISMATCH")
    return ok

if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "plan"
    only = args[args.index("--only") + 1] if "--only" in args else None
    if cmd == "plan": cmd_plan()
    elif cmd == "add": cmd_add(args[1], args[2], args[3])
    elif cmd == "audition": cmd_audition(args[1], args[2], args[3])
    elif cmd == "generate": cmd_generate(only)
    elif cmd == "build": cmd_build(only)
    elif cmd == "verify": sys.exit(0 if cmd_verify() else 1)
    else: raise SystemExit(__doc__)
