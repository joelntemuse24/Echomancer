from typing import TypedDict
import base64
import ormsgpack
import requests
import runpod

from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest

FISH_SERVER_URL = "http://127.0.0.1:8080/v1/tts"


class Job(TypedDict):
    id: str
    input: dict


async def handler(job: Job) -> dict:
    job_input = job["input"]

    # Build references if provided
    references = []
    ref_audios = job_input.get("reference_audio", [])  # list of base64 strings
    ref_texts = job_input.get("reference_text", [])

    for audio_b64, text in zip(ref_audios, ref_texts):
        audio_bytes = base64.b64decode(audio_b64) if audio_b64 else b""
        references.append(ServeReferenceAudio(audio=audio_bytes, text=text))

    request = ServeTTSRequest(
        text=job_input["text"],
        references=references,
        reference_id=job_input.get("reference_id", None),
        format=job_input.get("format", "wav"),
        max_new_tokens=job_input.get("max_new_tokens", 1024),
        chunk_length=job_input.get("chunk_length", 300),
        top_p=job_input.get("top_p", 0.8),
        repetition_penalty=job_input.get("repetition_penalty", 1.1),
        temperature=job_input.get("temperature", 0.8),
        streaming=False,
        use_memory_cache=job_input.get("use_memory_cache", "off"),
        seed=job_input.get("seed", None),
    )

    response = requests.post(
        FISH_SERVER_URL,
        params={"format": "msgpack"},
        data=ormsgpack.packb(request, option=ormsgpack.OPT_SERIALIZE_PYDANTIC),
        headers={"content-type": "application/msgpack"},
    )

    if response.status_code != 200:
        return {"error": f"Fish server error {response.status_code}", "detail": response.text}

    audio_b64 = base64.b64encode(response.content).decode("utf-8")
    return {
        "audio_base64": audio_b64,
        "format": request.format,
    }

runpod.serverless.start({"handler": handler})
