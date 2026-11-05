#!/usr/bin/env python3
"""Live Qwen TTS experiments for the gurgle, with a hard character budget.

Reads DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID from the environment only.
Never prints the key, the workspace id, or a signed audio link. Every
synthesis call is charged to a JSON ledger before it is sent and refused
once the ledger would pass --cap.

    python3 scripts/qwen/gurgle_lab.py voices
    python3 scripts/qwen/gurgle_lab.py render --voice <id> --text-file t.txt \
        --out renders/x.wav [--model ...] [--format wav] [--sample-rate 24000] \
        [--seed 42] [--transport http|sse|ws] [--param rate=1.0 ...] [--note ...]
    python3 scripts/qwen/gurgle_lab.py enroll --audio ref.wav --prefix name \
        [--target-model ...] [--preprocess] [--max-prompt 10]
    python3 scripts/qwen/gurgle_lab.py ledger

Library use: `from gurgle_lab import Lab; lab = Lab(ledger, cap)`.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

FLASH = "qwen-audio-3.1-tts-flash"


def _env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"{name} is not set")
    return v


class Lab:
    def __init__(self, ledger: str, cap: int = 20_000):
        self.key = _env("DASHSCOPE_API_KEY")
        ws = _env("DASHSCOPE_WORKSPACE_ID")
        self.ws = ws
        base = os.environ.get("DASHSCOPE_BASE_URL", "").strip().rstrip("/")
        self.base = base or f"https://{ws}.ap-southeast-1.maas.aliyuncs.com/api/v1"
        self.wss = f"wss://{ws}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference"
        self.ledger = ledger
        self.cap = cap

    # ------------------------------------------------------------ hygiene
    def redact(self, s) -> str:
        s = str(s).replace(self.key, "<key>").replace(self.ws, "<ws>")
        import re
        return re.sub(r"https?://[^\s\"']+", "<url>", s)

    def charge(self, n: int, model: str, note: str) -> int:
        os.makedirs(os.path.dirname(os.path.abspath(self.ledger)), exist_ok=True)
        with open(self.ledger, "a+") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0)
            raw = f.read()
            d = json.loads(raw) if raw.strip() else {"total": 0, "calls": []}
            if d["total"] + n > self.cap:
                raise RuntimeError(f"BUDGET STOP: {d['total']} + {n} > {self.cap}")
            d["total"] += n
            d["calls"].append({"n": n, "model": model, "note": note, "t": time.strftime("%H:%M:%S")})
            f.seek(0)
            f.truncate()
            f.write(json.dumps(d, indent=1))
        return d["total"]

    @staticmethod
    def cost(text: str) -> int:
        return len(text) + sum(1 for c in text if ord(c) > 127)

    # ------------------------------------------------------------ http
    def _post(self, url: str, body: dict, headers: dict | None = None, timeout: int = 300):
        req = urllib.request.Request(
            url, data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json", **(headers or {})},
        )
        return urllib.request.urlopen(req, timeout=timeout)

    def _post_json(self, url: str, body: dict, timeout: int = 300):
        try:
            with self._post(url, body, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"raw": self.redact(raw[:600])}

    def customization(self, input_: dict) -> tuple[int, dict]:
        return self._post_json(f"{self.base}/services/audio/tts/customization",
                               {"model": "voice-enrollment", "input": input_}, timeout=180)

    def list_voices(self, target_model: str | None = None) -> list[dict]:
        out = []
        for page in range(0, 10):
            inp = {"action": "list_voice", "page_size": 100, "page_index": page}
            if target_model:
                inp["target_model"] = target_model
            st, j = self.customization(inp)
            if st != 200:
                raise RuntimeError(f"list_voice {st}: {self.redact(j)}")
            vl = (j.get("output") or {}).get("voice_list") or []
            out += vl
            if len(vl) < 100:
                break
        return out

    def enroll(self, audio: bytes, prefix: str, target_model: str = FLASH, mime: str = "audio/wav",
               preprocess: bool = False, max_prompt: float | None = None) -> dict:
        inp = {
            "action": "create_voice", "target_model": target_model, "prefix": prefix,
            "audio": f"data:{mime};base64,{base64.b64encode(audio).decode()}",
            "language_hints": ["en"], "enable_preprocess": preprocess,
        }
        if max_prompt is not None:
            inp["max_prompt_audio_length"] = max_prompt
        st, j = self.customization(inp)
        return {"status": st, "voice_id": (j.get("output") or {}).get("voice_id"),
                "error": None if st == 200 else self.redact(j)}

    # ------------------------------------------------------------ synthesis
    def render(self, *, voice: str, text: str, out: str, model: str = FLASH, fmt: str = "wav",
               sample_rate: int = 24000, seed: int | None = 42, transport: str = "http",
               params: dict | None = None, note: str = "") -> dict:
        n = self.cost(text) + sum(self.cost(str(v)) for k, v in (params or {}).items() if k == "instruction")
        self.charge(n, model, note or os.path.basename(out))
        t0 = time.time()
        try:
            if transport == "ws":
                res = self._render_ws(voice, text, model, fmt, sample_rate, seed, params or {})
            else:
                res = self._render_http(voice, text, model, fmt, sample_rate, seed, params or {}, sse=transport == "sse")
        except Exception as e:  # network or protocol error
            res = {"ok": False, "error": self.redact(f"{type(e).__name__}: {e}")}
        res.update({"chars": len(text), "charged": n, "wall_s": round(time.time() - t0, 2), "transport": transport,
                    "model": model, "format": fmt, "sample_rate": sample_rate, "seed": seed, "params": params or {}})
        audio = res.pop("audio", None)
        if audio:
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            with open(out, "wb") as f:
                f.write(audio)
            res["bytes"] = len(audio)
            res["out"] = out
        return res

    def _render_http(self, voice, text, model, fmt, sr, seed, params, sse=False):
        inp = {"text": text, "voice": voice, "format": fmt, "sample_rate": sr, "language_hints": ["en"]}
        if seed is not None:
            inp["seed"] = seed
        inp.update(params)
        body = {"model": model, "input": inp}
        url = f"{self.base}/services/audio/tts/SpeechSynthesizer"
        if not sse:
            st, j = self._post_json(url, body)
            u = ((j.get("output") or {}).get("audio") or {}).get("url")
            if st != 200 or not u:
                return {"ok": False, "status": st, "error": self.redact(j), "request_id": j.get("request_id")}
            u = u.replace("http://", "https://", 1)
            with urllib.request.urlopen(u, timeout=300) as r:
                audio = r.read()
            return {"ok": True, "status": st, "audio": audio, "request_id": j.get("request_id"), "usage": j.get("usage")}
        try:
            resp = self._post(url, body, headers={"X-DashScope-SSE": "enable"})
        except urllib.error.HTTPError as e:
            return {"ok": False, "status": e.code, "error": self.redact(e.read().decode(errors="replace")[:600])}
        chunks, usage, rid, events = [], None, None, 0
        with resp:
            for raw in resp:
                line = raw.decode(errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                events += 1
                d = json.loads(line[5:])
                rid = d.get("request_id", rid)
                usage = d.get("usage", usage)
                a = ((d.get("output") or {}).get("audio") or {})
                if a.get("data"):
                    chunks.append(base64.b64decode(a["data"]))
                if d.get("code"):
                    return {"ok": False, "error": self.redact({k: d.get(k) for k in ("code", "message")}), "request_id": rid}
        audio = b"".join(chunks)
        return {"ok": bool(audio), "audio": audio, "request_id": rid, "usage": usage, "events": events}

    def _render_ws(self, voice, text, model, fmt, sr, seed, params):
        import websocket  # websocket-client
        tid = str(uuid.uuid4())
        p = {"text_type": "PlainText", "voice": voice, "format": fmt, "sample_rate": sr, "language_hints": ["en"]}
        if seed is not None:
            p["seed"] = seed
        p.update(params)
        ws = websocket.create_connection(self.wss, header=[f"Authorization: Bearer {self.key}", f"X-DashScope-WorkSpace: {self.ws}"],
                                     timeout=180)
        audio, err, usage, sent = bytearray(), None, None, False
        try:
            ws.send(json.dumps({"header": {"action": "run-task", "task_id": tid, "streaming": "duplex"},
                                "payload": {"task_group": "audio", "task": "tts", "function": "SpeechSynthesizer",
                                            "model": model, "parameters": p, "input": {}}}))
            while True:
                op, data = ws.recv_data()
                if op == websocket.ABNF.OPCODE_BINARY:
                    audio += data
                    continue
                msg = json.loads(data)
                ev = msg["header"].get("event")
                usage = (msg.get("payload") or {}).get("usage") or usage
                if ev == "task-started" and not sent:
                    for a, inp in (("continue-task", {"text": text}), ("finish-task", {})):
                        ws.send(json.dumps({"header": {"action": a, "task_id": tid, "streaming": "duplex"},
                                            "payload": {"input": inp}}))
                    sent = True
                elif ev == "task-finished":
                    break
                elif ev == "task-failed":
                    err = self.redact({"code": msg["header"].get("error_code"),
                                       "message": msg["header"].get("error_message")})
                    break
        finally:
            ws.close()
        return {"ok": err is None and bool(audio), "error": err, "audio": bytes(audio), "usage": usage}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default=os.environ.get("QWEN_LAB_LEDGER", "qwen-lab/ledger.json"))
    ap.add_argument("--cap", type=int, default=int(os.environ.get("QWEN_LAB_CAP", "20000")))
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("voices")
    v.add_argument("--target-model")
    r = sub.add_parser("render")
    r.add_argument("--voice", required=True)
    r.add_argument("--text-file", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--model", default=FLASH)
    r.add_argument("--format", default="wav")
    r.add_argument("--sample-rate", type=int, default=24000)
    r.add_argument("--seed", type=int, default=42)
    r.add_argument("--transport", choices=["http", "sse", "ws"], default="http")
    r.add_argument("--param", action="append", default=[], help="key=value (JSON value if it parses)")
    r.add_argument("--note", default="")
    e = sub.add_parser("enroll")
    e.add_argument("--audio", required=True)
    e.add_argument("--prefix", required=True)
    e.add_argument("--target-model", default=FLASH)
    e.add_argument("--preprocess", action="store_true")
    e.add_argument("--max-prompt", type=float)
    sub.add_parser("ledger")
    a = ap.parse_args(argv)

    if a.cmd == "ledger":
        print(open(a.ledger).read() if os.path.exists(a.ledger) else "{}")
        return 0
    lab = Lab(a.ledger, a.cap)
    if a.cmd == "voices":
        for x in lab.list_voices(a.target_model):
            print(json.dumps({k: x.get(k) for k in ("voice_id", "target_model", "status", "gmt_create")}))
    elif a.cmd == "render":
        params = {}
        for kv in a.param:
            k, _, val = kv.partition("=")
            try:
                params[k] = json.loads(val)
            except json.JSONDecodeError:
                params[k] = val
        text = open(a.text_file).read().strip()
        res = lab.render(voice=a.voice, text=text, out=a.out, model=a.model, fmt=a.format,
                         sample_rate=a.sample_rate, seed=a.seed, transport=a.transport, params=params, note=a.note)
        print(json.dumps(res))
    elif a.cmd == "enroll":
        mime = "audio/mpeg" if a.audio.endswith(".mp3") else "audio/wav"
        print(json.dumps(lab.enroll(open(a.audio, "rb").read(), a.prefix, a.target_model, mime,
                                    a.preprocess, a.max_prompt)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
