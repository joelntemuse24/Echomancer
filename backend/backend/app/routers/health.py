from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Dict
import redis.asyncio as redis

from ..config import get_settings, Settings

router = APIRouter(tags=["Health"])


class HealthResponse(BaseModel):
    status: str
    services: Dict[str, str]


@router.get("/health", response_model=HealthResponse)
async def health_check(settings: Settings = Depends(get_settings)):
    """
    Health check endpoint.

    Checks connectivity to required services.
    """
    services = {}

    # Check Redis
    try:
        r = redis.Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
        )
        await r.ping()
        await r.close()
        services["redis"] = "ok"
    except Exception as e:
        services["redis"] = f"error: {str(e)}"

    # Check API keys configured
    services["tts_provider"] = settings.tts_provider
    services["vastai"] = "configured" if settings.vastai_api_key else "not configured"
    services["youtube"] = "configured" if settings.youtube_api_key else "not configured"
    services["paddle"] = "configured" if settings.paddle_api_key else "not configured"
    services["bunny"] = "configured" if settings.bunny_api_key else "not configured"

    # Overall status
    all_ok = all(v in ["ok", "configured"] for v in services.values())
    status = "healthy" if all_ok else "degraded"

    return HealthResponse(status=status, services=services)
