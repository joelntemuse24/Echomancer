from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Server
    port: int = 8000
    frontend_url: str = "http://localhost:3000"
    environment: str = "development"

    # Redis
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""

    # TTS Provider: "vastai", "local", "replicate", or "mock"
    # F5-TTS is the recommended model for high-quality voice cloning
    tts_provider: str = "vastai"

    # Replicate (Fish Speech) - ~$0.10-0.50 per audiobook, fully serverless
    # Get your token at: https://replicate.com/account/api-tokens
    replicate_api_token: str = ""

    # Vast.ai (F5-TTS self-hosted) - ~$0.15-0.50 per 10hr audiobook
    # See vastai-scripts/README.md for setup instructions
    vastai_url: str = ""  # e.g., "http://123.456.789.10:8080"
    vastai_api_key: str = ""

    # Reference text for voice cloning (transcription of the reference audio)
    # Leave empty to use automatic speech recognition
    tts_ref_text: str = ""

    # YouTube Data API
    youtube_api_key: str = ""

    # Clerk Authentication
    clerk_secret_key: str = ""
    clerk_publishable_key: str = ""

    # Paddle Payments
    paddle_api_key: str = ""
    paddle_environment: str = "sandbox"
    paddle_webhook_secret: str = ""
    paddle_one_time_price_id: str = ""
    paddle_subscription_price_id: str = ""

    # Bunny.net CDN
    bunny_storage_zone: str = ""
    bunny_api_key: str = ""
    bunny_cdn_url: str = ""

    # Paths
    temp_dir: str = "/tmp/echomancer"

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
