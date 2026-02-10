from pydantic_settings import BaseSettings
from functools import lru_cache
import os


class Settings(BaseSettings):
    # Server
    port: int = 8000
    frontend_url: str = "http://localhost:3000"
    environment: str = "development"
    secret_key: str = "change-me-in-production"

    # Redis (optional - for job queue)
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""

    # Supabase Database
    # Get these from: https://supabase.com/dashboard/project/_/settings/api
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_key: str = ""  # For server-side operations

    # TTS Provider: "chatterbox", "replicate", or "mock"
    # chatterbox = best quality + cheapest (~$0.10-0.30/book, local GPU)
    # replicate = easiest setup (~$1.50/book, cloud API)
    tts_provider: str = "chatterbox"

    # Chatterbox TTS (Resemble AI) - Local GPU inference
    # Deploy on TensorDock RTX 4090 (~$0.35/hr)
    chatterbox_device: str = "cuda"  # "cuda" or "cpu"
    chatterbox_exaggeration: float = 0.5  # Emotion level: 0.0=neutral, 1.0=expressive
    chatterbox_cfg_weight: float = 0.5  # Stability: 0.0=variable, 1.0=stable

    # Replicate (Minimax) - Cloud fallback, higher cost
    # Get your token at: https://replicate.com/account/api-tokens
    replicate_api_token: str = ""

    # Vast.ai (F5-TTS) - Legacy option
    vastai_url: str = ""  # e.g., "http://123.456.789.10:8080"
    vastai_api_key: str = ""

    # Reference text for voice cloning (transcription of the reference audio)
    tts_ref_text: str = ""

    # YouTube Data API (for voice search feature)
    youtube_api_key: str = ""

    # Stripe Payments
    # Get keys from: https://dashboard.stripe.com/apikeys
    stripe_secret_key: str = ""
    stripe_publishable_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_id_one_time: str = ""  # One-time audiobook purchase
    stripe_price_id_subscription: str = ""  # Monthly subscription

    # Bunny.net CDN (for storing generated audiobooks)
    bunny_storage_zone: str = ""
    bunny_api_key: str = ""
    bunny_cdn_url: str = ""

    # Paths
    temp_dir: str = "/tmp/echomancer"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def redis_url(self) -> str:
        if self.redis_password:
            return f"redis://:{self.redis_password}@{self.redis_host}:{self.redis_port}"
        return f"redis://{self.redis_host}:{self.redis_port}"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
