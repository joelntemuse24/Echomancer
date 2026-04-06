import os
import modal
import json
from fastapi import Request, FastAPI

# We use vLLM for blazing fast inference
vllm_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "vllm==0.6.3.post1",
        "huggingface_hub",
        "hf-transfer"
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

app = modal.App("echomancer-llm-director")

# Qwen 2.5 0.5B - small & fast, loads in ~10-20 seconds vs 5-10 minutes for 7B
# Perfect for punctuation/speed analysis task
MODEL_NAME = "Qwen/Qwen2.5-0.5B-Instruct"

# Cache the model weights to a Modal Volume
model_volume = modal.Volume.from_name("echomancer-models", create_if_missing=True)
MODEL_DIR = "/model"

@app.function(
    image=vllm_image,
    volumes={MODEL_DIR: model_volume},
    timeout=3600,
)
def download_model():
    from huggingface_hub import snapshot_download
    print(f"Downloading {MODEL_NAME} to {MODEL_DIR}...")
    snapshot_download(
        MODEL_NAME,
        local_dir=f"{MODEL_DIR}/{MODEL_NAME}",
        ignore_patterns=["*.pt", "*.bin"], # Download safetensors only
    )
    print("Download complete!")

web_app = FastAPI()

@app.cls(
    image=vllm_image,
    gpu="T4", # T4 is cheaper (~$0.40/hr) and sufficient for 0.5B model
    volumes={MODEL_DIR: model_volume},
    scaledown_window=300, # Keep warm for 5 minutes after use
)
@modal.concurrent(max_inputs=100)
class LLMDirector:
    @modal.enter()
    def load_model(self):
        from vllm import LLM
        import os
        
        model_path = f"{MODEL_DIR}/{MODEL_NAME}"
        if not os.path.exists(model_path):
            print("Model not found locally, downloading...")
            from huggingface_hub import snapshot_download
            snapshot_download(
                MODEL_NAME,
                local_dir=model_path,
                ignore_patterns=["*.pt", "*.bin"]
            )
            
        print("Loading vLLM engine...")
        self.llm = LLM(
            model=model_path,
            tensor_parallel_size=1,
            gpu_memory_utilization=0.90,
            max_model_len=4096,
            enforce_eager=False,
        )
        print("Model loaded successfully!")

    @modal.method()
    def process_text(self, text: str):
        from vllm import SamplingParams
        
        # We instruct the model to output JSON with modified text and parameters
        prompt = f"""You are an expert audiobook director. Your job is to analyze the following text chunk and prepare it for a Text-to-Speech engine.
        
1. "modified_text": Rewrite the punctuation ONLY to guide the TTS engine's pacing. 
   - Add em-dashes (--) or ellipses (...) for profound pauses.
   - Remove unnecessary commas to speed up fast action or rapid dialogue.
   - Do NOT change any words, only punctuation.
2. "speed": A float between 0.85 (slow/profound) and 1.15 (fast/action/urgent). 1.0 is normal.
3. "energy": Either "low" (sad, profound, whisper), "neutral" (normal narration), or "high" (shouting, action, excitement).

Text to process:
"{text}"

Output strictly valid JSON and nothing else."""

        sampling_params = SamplingParams(
            temperature=0.1, # Low temp for deterministic JSON output
            max_tokens=1024,
            stop=["```\n", "}\n\n"],
        )
        
        messages = [
            {"role": "system", "content": "You are a helpful JSON-generating assistant."},
            {"role": "user", "content": prompt}
        ]
        
        # Format using Qwen's chat template
        from transformers import AutoTokenizer
        tokenizer = self.llm.get_tokenizer()
        formatted_prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        
        outputs = self.llm.generate([formatted_prompt], sampling_params, use_tqdm=False)
        result_text = outputs[0].outputs[0].text.strip()
        
        # Clean up Markdown formatting if the model wrapped it in ```json
        if result_text.startswith("```json"):
            result_text = result_text[7:]
        if result_text.startswith("```"):
            result_text = result_text[3:]
        if result_text.endswith("```"):
            result_text = result_text[:-3]
            
        try:
            return json.loads(result_text.strip())
        except Exception as e:
            print(f"Failed to parse JSON: {result_text}")
            # Fallback
            return {
                "modified_text": text,
                "speed": 1.0,
                "energy": "neutral"
            }

    @modal.fastapi_endpoint(method="POST")
    def direct(self, request: dict):
        text = request.get("text", "")
        if not text:
            return {"error": "No text provided"}
            
        result = self.process_text.local(text)
        return result
