"""
Narration -> word timings, for the subtitle track.

Invoked by `src/engine/transcribe/whisper.js`; not meant to be interesting on
its own. It is a separate process rather than a library binding because
faster-whisper is Python and the rest of the tool is not, and because a
transcription is a minute of CPU that must not block the event loop of whatever
spawned it.

The contract with the caller:
  - the word array is written to `--out` as JSON, never to stdout
  - progress is written to stderr as one JSON object per line
  - a non-zero exit means the JSON was not written

stdout is left clean so the caller never has to separate a model's chatter from
the payload.
"""

import argparse
import json
import sys


def eprint(obj):
    """One JSON object per line on stderr: the progress channel."""
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def main():
    ap = argparse.ArgumentParser(description="Transcribe narration to word timings.")
    ap.add_argument("--audio", required=True, help="path to the narration file")
    ap.add_argument("--out", required=True, help="where to write the word JSON")
    # small.en is the accuracy/speed knee for English narration: noticeably
    # better than base.en at punctuation, which is what decides where one
    # subtitle ends and the next begins, and still real-time-ish on a CPU.
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--language", default="en")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        eprint({
            "error": "faster-whisper is not installed. "
                     "Run: python3 -m venv .venv && "
                     ".venv/bin/pip install -r requirements.txt"
        })
        return 2

    eprint({"stage": "loading", "model": args.model})
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    segments, info = model.transcribe(
        args.audio,
        # The model is English-only, so detection can only agree or be wrong.
        language=args.language,
        word_timestamps=True,
        beam_size=5,
    )

    total = getattr(info, "duration", 0) or 0
    words = []

    # `segments` is a generator: the work happens as it is drained, which is
    # what makes progress reportable at all.
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if not text:
                continue
            words.append({
                "w": text,
                "start": round(word.start, 3),
                "end": round(word.end, 3),
            })
        if total:
            eprint({"progress": min(1.0, round(segment.end / total, 4))})

    if not words:
        eprint({"error": f"no speech found in {args.audio}"})
        return 1

    with open(args.out, "w") as f:
        json.dump(words, f, indent=2)

    eprint({"progress": 1.0, "words": len(words), "duration": round(total, 3)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
