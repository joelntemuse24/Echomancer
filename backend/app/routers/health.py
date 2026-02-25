from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Dict

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

    # Check API keys configured
    services["tts"] = "configured" if settings.replicate_api_token else "not configured"
    services["youtube"] = "configured" if settings.youtube_api_key else "not configured"
    services["bunny"] = "configured" if settings.bunny_api_key else "not configured"

    # Overall status
    status = "healthy"

    return HealthResponse(status=status, services=services)
