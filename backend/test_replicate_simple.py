"""Test if Replicate API token works at all"""
import replicate
import os

os.environ["REPLICATE_API_TOKEN"] = "r8_GFm7tLruFlpBUAosS thGmXxBBzsIKO54embSK"

try:
    # Test with a simple, popular model
    print("Testing Replicate API token...")
    output = replicate.run(
        "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
        input={"prompt": "test"}
    )
    print(f"[OK] Replicate API token works!")
    print(f"Output type: {type(output)}")
except Exception as e:
    print(f"[FAIL] Replicate API token test failed: {e}")
    import traceback
    traceback.print_exc()
