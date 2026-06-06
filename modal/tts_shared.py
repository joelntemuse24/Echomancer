"""Shared TTS orchestration helpers (R2, ffmpeg, text, webhooks). No Modal app definitions."""

from __future__ import annotations

import base64
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from typing import List

MAX_PARAGRAPH_CHARS = 1500
PARAGRAPH_SILENCE = 0.5


def normalize_punctuation(text: str) -> str:
    text = re.sub(r"!{2,}", "!", text)
    text = re.sub(r"\?{2,}", "?", text)
    text = re.sub(r"[?!]{2,}", "?", text)

    def fix_all_caps(match):
        word = match.group(0)
        return word.title() if len(word) >= 5 else word

    text = re.sub(r"\b[A-Z]{5,}\b", fix_all_caps, text)
    text = re.sub(r"(\S)—(\S)", r"\1 — \2", text)
    text = re.sub(r"(\S)--(\S)", r"\1 -- \2", text)
    text = re.sub(r"\.{3,}", "…", text)
    return text


def normalize_text(text: str) -> str:
    from num2words import num2words

    abbreviations = {
        r"\bDr\.\b": "Doctor",
        r"\bMr\.\b": "Mister",
        r"\bMrs\.\b": "Missus",
        r"\bMs\.\b": "Miss",
        r"\bSt\.\b": "Saint",
        r"\betc\.\b": "et cetera",
        r"\bi\.e\.\b": "that is",
        r"\be\.g\.\b": "for example",
    }
    for pattern, replacement in abbreviations.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    def large_number_to_words(match):
        try:
            return num2words(int(match.group(0).replace(",", "")))
        except Exception:
            return match.group(0)

    text = re.sub(r"\b\d{1,3}(?:,\d{3})+\b", large_number_to_words, text)

    def number_to_words(match):
        num = int(match.group(0))
        if num > 20:
            try:
                return num2words(num)
            except Exception:
                return match.group(0)
        return match.group(0)

    text = re.sub(r"\b\d{2,}\b", number_to_words, text)
    return text


def split_text_into_paragraphs(text: str, max_chars: int = MAX_PARAGRAPH_CHARS) -> List[str]:
    raw_paragraphs = re.split(r"\n\s*\n", text.strip())
    paragraphs = []

    for para in raw_paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) <= max_chars:
            paragraphs.append(para)
            continue

        sentences = re.split(r"(?<=[.!?])\s+", para)
        current: list[str] = []
        current_len = 0

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            sent_len = len(sentence)
            if current_len + sent_len + 1 <= max_chars:
                current.append(sentence)
                current_len += sent_len + 1
            else:
                if current:
                    paragraphs.append(" ".join(current))
                if sent_len > max_chars:
                    words = sentence.split()
                    current = []
                    current_len = 0
                    for word in words:
                        if current_len + len(word) + 1 <= max_chars:
                            current.append(word)
                            current_len += len(word) + 1
                        else:
                            if current:
                                paragraphs.append(" ".join(current))
                            current = [word]
                            current_len = len(word)
                else:
                    current = [sentence]
                    current_len = sent_len
        if current:
            paragraphs.append(" ".join(current))

    return [p for p in paragraphs if p.strip()]


def get_r2_client():
    import boto3
    from botocore.config import Config

    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not all([account_id, access_key, secret_key]):
        raise ValueError("R2 credentials not configured")
    config = Config(connect_timeout=30, read_timeout=60)
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    )


def verify_r2_permissions(client, bucket: str) -> bool:
    try:
        client.list_objects_v2(Bucket=bucket, MaxKeys=1)
        return True
    except Exception as e:
        print(f"[R2] Permission check failed: {e}")
        return False


def download_from_r2(client, bucket: str, key: str, local_path: str):
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        with open(local_path, "wb") as f:
            f.write(response["Body"].read())
    except Exception as e:
        print(f"[R2] get_object failed for {bucket}/{key}: {e}")
        client.download_file(bucket, key, local_path)


def upload_to_r2(client, bucket: str, key: str, local_path: str, content_type: str = "application/octet-stream"):
    client.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": content_type})


def clip_audio_ffmpeg(input_path: str, output_path: str, start_time: float, duration: float, sample_rate: int = 24000):
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-ss", str(start_time), "-t", str(duration),
        "-ac", "1", "-ar", str(sample_rate), output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def concatenate_audio_ffmpeg(audio_files: List[str], output_path: str, crossfade_duration: float = 0.05):
    if not audio_files:
        raise ValueError("No audio files to concatenate")
    if len(audio_files) == 1:
        shutil.copy(audio_files[0], output_path)
        return

    if len(audio_files) == 2:
        cmd = [
            "ffmpeg", "-y", "-i", audio_files[0], "-i", audio_files[1],
            "-filter_complex", f"[0][1]acrossfade=d={crossfade_duration}:c1=tri:c2=tri",
            output_path,
        ]
    else:
        inputs = []
        for f in audio_files:
            inputs.extend(["-i", f])
        filter_parts = [f"[0][1]acrossfade=d={crossfade_duration}:c1=tri:c2=tri[a01]"]
        for i in range(2, len(audio_files)):
            prev = f"a{i-2:02d}" if i > 2 else "a01"
            filter_parts.append(f"[{prev}][{i}]acrossfade=d={crossfade_duration}:c1=tri:c2=tri[a{i-1:02d}]")
        output_label = f"a{len(audio_files)-2:02d}"
        cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", ";".join(filter_parts), "-map", f"[{output_label}]", output_path]

    subprocess.run(cmd, check=True, capture_output=True, text=True)


def normalize_audio_ffmpeg(input_path: str, output_path: str, sample_rate: int = 24000):
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-af",
        "acompressor=threshold=-20dB:ratio=3:attack=5:release=100,"
        "equalizer=f=3000:width_type=h:width=200:g=2,"
        "highpass=f=80,"
        "loudnorm=I=-16:TP=-1.5:LRA=11,"
        "alimiter=level_in=1:level_out=1:limit=0.95",
        "-ar", str(sample_rate), "-b:a", "192k", output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def insert_silence_between_chunks(audio_files: List[str], output_path: str, silence_duration: float = PARAGRAPH_SILENCE):
    if not audio_files:
        raise ValueError("No audio files to concatenate")
    if len(audio_files) == 1:
        shutil.copy(audio_files[0], output_path)
        return

    inputs = []
    for f in audio_files:
        inputs.extend(["-i", f])

    filter_parts = []
    for i in range(len(audio_files) - 1):
        filter_parts.append(f"[{i}:a]apad=pad_dur={silence_duration}[padded{i}]")
    inputs_str = "".join([f"[padded{i}]" for i in range(len(audio_files) - 1)]) + f"[{len(audio_files) - 1}:a]"
    filter_parts.append(f"{inputs_str}concat=n={len(audio_files)}:v=0:a=1[out]")
    cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", ";".join(filter_parts), "-map", "[out]", output_path]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def send_webhook_sync(url: str, payload: dict, max_retries: int = 3) -> bool:
    import httpx

    headers = {"X-Webhook-Secret": os.environ.get("WEBHOOK_SECRET", "")}
    for attempt in range(max_retries):
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(url, json=payload, headers=headers)
                print(f"[Webhook] {url} -> {response.status_code}")
                if response.status_code < 400:
                    return True
        except Exception as e:
            print(f"[Webhook] Attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
    return False


def send_webhook_async(url: str, payload: dict):
    def _send():
        try:
            send_webhook_sync(url, payload)
        except Exception as e:
            print(f"[Webhook Async] Failed: {e}")

    threading.Thread(target=_send, daemon=True).start()


def decode_audio_base64(audio_base64: str) -> tuple:
    import soundfile as sf

    audio_bytes = base64.b64decode(audio_base64)
    audio_io = io.BytesIO(audio_bytes)
    audio, sr = sf.read(audio_io, dtype="float32")
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    return audio.astype("float32", copy=False), sr