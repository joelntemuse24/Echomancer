from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from typing import List, Optional

from ..config import get_settings, Settings
from ..services import youtube as youtube_service

router = APIRouter(prefix="/youtube", tags=["YouTube"])


class VideoResult(BaseModel):
    id: str
    title: str
    description: str
    thumbnail: str
    channelTitle: str
    duration: str
    durationSeconds: int


class SearchResponse(BaseModel):
    videos: List[VideoResult]
    query: str


@router.get("/search", response_model=SearchResponse)
async def search_videos(
    q: str = Query(..., min_length=1, description="Search query"),
    max_results: int = Query(10, ge=1, le=50),
    settings: Settings = Depends(get_settings)
):
    """
    Search YouTube for videos.

    Returns video metadata including duration for voice selection.
    """
    if not settings.youtube_api_key:
        raise HTTPException(
            status_code=503,
            detail="YouTube API key not configured"
        )

    try:
        videos = await youtube_service.search_videos(
            query=q,
            api_key=settings.youtube_api_key,
            max_results=max_results,
        )

        return SearchResponse(
            videos=[VideoResult(**v) for v in videos],
            query=q,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@router.get("/video/{video_id}", response_model=VideoResult)
async def get_video_details(
    video_id: str,
    settings: Settings = Depends(get_settings)
):
    """Get details for a specific YouTube video."""
    if not settings.youtube_api_key:
        raise HTTPException(
            status_code=503,
            detail="YouTube API key not configured"
        )

    try:
        details = await youtube_service.get_video_details(
            [video_id],
            settings.youtube_api_key
        )

        if not details:
            raise HTTPException(status_code=404, detail="Video not found")

        video = details[0]
        return VideoResult(
            id=video["id"],
            title=video.get("title", ""),
            description="",
            thumbnail=f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
            channelTitle="",
            duration=video.get("duration", ""),
            durationSeconds=youtube_service.parse_duration(video.get("duration", "")),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get video: {str(e)}")
