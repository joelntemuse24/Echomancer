from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Server
    port: int = 8000
    frontend_url: str = "http://localhost:3000"
    environment: str = "development"
    secret_key: str = "change-me-in-production"

    # Supabase Database
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_key: str = ""

    # F5-TTS via Replicate API
    replicate_api_token: str = ""
    f5tts_model: str = "x-lance/f5-tts"

    # YouTube Data API
    youtube_api_key: str = ""

    # Stripe Payments
    stripe_secret_key: str = ""
    stripe_publishable_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_id_one_time: str = ""
    stripe_price_id_subscription: str = ""

    # Bunny.net CDN
    bunny_storage_zone: str = ""
    bunny_api_key: str = ""
    bunny_cdn_url: str = ""

    # Temp directory for processing
    temp_dir: str = "/tmp/echomancer"

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
