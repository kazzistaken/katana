"""
NVIDIA Canary-Qwen 2.5B as a small local helper for Katana's dictation
(src/main/canary.js starts it, with the Python from scripts/setup-canary.mjs).

It loads the model once, then takes one JSON request per line on stdin and
answers one JSON line on stdout. Nothing leaves this PC.

  -> {"id": 1, "wav": "C:/.../phrase.wav"}      any rate, mono or stereo
  <- {"id": 1, "text": "Fix the login bug."}    or {"id": 1, "error": "..."}

It says {"ready": true, "device": ..., "ms": ...} once the model is loaded and
ends when stdin closes, so it can't outlive the app. NeMo's own logging is
sent to stderr: stdout carries these lines only.
"""

import json
import os
import sys
import tempfile
import time

# stdout is for answers only, whatever the libraries print.
out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL = "nvidia/canary-qwen-2.5b"
RATE = 16000
MAX_NEW_TOKENS = 256


def say(**fields):
    out.write(json.dumps(fields) + "\n")
    out.flush()


def as_16k_mono(path):
    """What the model takes: 16 kHz mono. A file already like that is used as it is."""
    import soundfile as sf
    import torch
    import torchaudio

    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    if audio.shape[1] == 1 and rate == RATE:
        return path, None
    samples = torch.from_numpy(audio).mean(dim=1, keepdim=True).T
    if rate != RATE:
        samples = torchaudio.functional.resample(samples, rate, RATE)
    handle, converted = tempfile.mkstemp(suffix=".wav")
    os.close(handle)
    sf.write(converted, samples.squeeze(0).numpy(), RATE, subtype="PCM_16")
    return converted, converted


def main():
    started = time.time()
    import torch
    from nemo.collections.speechlm2.models import SALM

    model = SALM.from_pretrained(MODEL)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # Half precision: about half the graphics memory (4.9 GB against 9.7), the same words, a little slower.
    # (Before it moves: at full size it would briefly need all 9.7 GB on the card.)
    if device == "cuda":
        model = model.half()
    model = model.to(device).eval()
    prompt = f"Transcribe the following: {model.audio_locator_tag}"
    say(ready=True, device=torch.cuda.get_device_name(0) if device == "cuda" else "cpu", ms=round((time.time() - started) * 1000))

    for line in sys.stdin:
        if not line.strip():
            continue
        request = {}
        converted = None
        try:
            request = json.loads(line)
            path, converted = as_16k_mono(request["wav"])
            with torch.inference_mode():
                ids = model.generate(
                    prompts=[[{"role": "user", "content": prompt, "audio": [path]}]],
                    max_new_tokens=MAX_NEW_TOKENS,
                )
            say(id=request.get("id"), text=model.tokenizer.ids_to_text(ids[0].cpu()).strip())
        except Exception as error:  # one bad phrase never ends the helper
            say(id=request.get("id"), error=str(error) or type(error).__name__)
        finally:
            if converted:
                try:
                    os.remove(converted)
                except OSError:
                    pass


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # couldn't load: says why, then ends
        say(failed=str(error) or type(error).__name__)
        sys.exit(1)
