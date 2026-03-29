import base64
import json
import requests

with open('temp_test_files/short.wav', 'rb') as f:
    audio_bytes = f.read()

metadata = json.dumps({"startTime": 0, "endTime": 3, "originalSize": len(audio_bytes)})
payload_bytes = metadata.encode('utf-8') + b'\n' + audio_bytes
payload_b64 = base64.b64encode(payload_bytes).decode('utf-8')

print("Sending request...")
response = requests.post(
    "https://ntemusejoel--zonos-tts-zonosserver-generate.modal.run",
    json={
        "text": "This is a test of the clipping metadata logic.",
        "reference_audio_base64": payload_b64,
        "format": "mp3",
        "has_clipping_metadata": True
    },
    timeout=300
)

print(f"Status Code: {response.status_code}")
try:
    data = response.json()
    if 'audio_base64' in data:
        print("Success! Audio generated.")
        data['audio_base64'] = data['audio_base64'][:50] + "..."
    print(data)
except Exception as e:
    print(f"Failed to parse JSON: {e}")
    print(response.text)
