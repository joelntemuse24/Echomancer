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

    # F5-TTS via Replicate API
    replicate_api_token: str = ""
    f5tts_model: str = "lucataco/f5-tts:9d976d38f905ee0c7631c947e1ad99ef57a52f5fa1a9eb7a6c96a1d61ed1f5a2"

    # YouTube Data API (for voice search feature)
    youtube_api_key: str = ""

    # Clerk Authentication (optional for dev, required for prod)
    # Get your keys at: https://dashboard.clerk.com
    clerk_secret_key: str = ""
    clerk_publishable_key: str = ""

    # Paddle Payments (optional for dev, required for prod)
    # Get your keys at: https://vendors.paddle.com
    paddle_api_key: str = ""
    paddle_environment: str = "sandbox"
    paddle_webhook_secret: str = ""
    paddle_one_time_price_id: str = ""
    paddle_subscription_price_id: str = ""

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

    # Temp directory for processing (use /tmp on Linux/Render)
    temp_dir: str = "/tmp/echomancer"

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
