from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
import uuid
import redis.asyncio as redis
from arq import create_pool
from arq.connections import RedisSettings

from ..config import get_settings, Settings

router = APIRouter(prefix="/queue", tags=["Queue"])


class CreateJobRequest(BaseModel):
    pdf_url: str
    video_id: Optional[str] = None
    audio_sample_url: Optional[str] = None
    start_time: float = 0.0
    end_time: float = 60.0


class CreateJobResponse(BaseModel):
    job_id: str
    status: str


class JobStatus(BaseModel):
    job_id: str
    status: str
    progress: int
    audio_url: Optional[str] = None
    error: Optional[str] = None


class JobListResponse(BaseModel):
    jobs: List[JobStatus]


# Redis connection pool
_redis_pool = None


async def get_redis(settings: Settings = Depends(get_settings)) -> redis.Redis:
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = redis.Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
            decode_responses=True,
        )
    return _redis_pool


@router.post("/create", response_model=CreateJobResponse)
async def create_job(
    request: CreateJobRequest,
    settings: Settings = Depends(get_settings),
    redis_client: redis.Redis = Depends(get_redis),
    # In production, add user authentication here
    user_id: str = "dev-user",  # Placeholder - would come from auth middleware
):
    """
    Create a new audiobook generation job.

    Requires either video_id (YouTube) or audio_sample_url (uploaded file).
    """
    # DEBUG: Log what we received
    print(f"DEBUG CREATE JOB - Received request:")
    print(f"  pdf_url: {request.pdf_url}")
    print(f"  video_id: {request.video_id}")
    print(f"  audio_sample_url: {request.audio_sample_url}")
    print(f"  start_time: {request.start_time}")
    print(f"  end_time: {request.end_time}")

    if not request.video_id and not request.audio_sample_url:
        raise HTTPException(
            status_code=400,
            detail="Either video_id or audio_sample_url must be provided"
        )

    job_id = str(uuid.uuid4())

    # Initialize job status in Redis
    await redis_client.set(f"job:{job_id}:status", "queued")
    await redis_client.set(f"job:{job_id}:progress", "0")
    await redis_client.set(f"job:{job_id}:user_id", user_id)

    # Store job in user's job list
    await redis_client.lpush(f"user:{user_id}:jobs", job_id)

    # Enqueue the job using ARQ
    try:
        arq_pool = await create_pool(RedisSettings(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
        ))

        await arq_pool.enqueue_job(
            "process_audiobook_job",
            job_id=job_id,
            user_id=user_id,
            pdf_url=request.pdf_url,
            video_id=request.video_id,
            audio_sample_url=request.audio_sample_url,
            start_time=request.start_time,
            end_time=request.end_time,
        )

        await arq_pool.close()
    except Exception as e:
        await redis_client.set(f"job:{job_id}:status", "failed")
        await redis_client.set(f"job:{job_id}:error", f"Failed to enqueue: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create job: {str(e)}")

    return CreateJobResponse(job_id=job_id, status="queued")


@router.get("/job/{job_id}", response_model=JobStatus)
async def get_job_status(
    job_id: str,
    redis_client: redis.Redis = Depends(get_redis),
):
    """Get the status of a specific job."""
    status = await redis_client.get(f"job:{job_id}:status")

    if not status:
        raise HTTPException(status_code=404, detail="Job not found")

    progress = await redis_client.get(f"job:{job_id}:progress") or "0"
    audio_url = await redis_client.get(f"job:{job_id}:audio_url")
    error = await redis_client.get(f"job:{job_id}:error")

    return JobStatus(
        job_id=job_id,
        status=status,
        progress=int(progress),
        audio_url=audio_url,
        error=error,
    )


@router.get("/jobs", response_model=JobListResponse)
async def get_user_jobs(
    redis_client: redis.Redis = Depends(get_redis),
    # In production, get user_id from auth
    user_id: str = "dev-user",
    limit: int = 20,
):
    """Get all jobs for the current user."""
    job_ids = await redis_client.lrange(f"user:{user_id}:jobs", 0, limit - 1)

    jobs = []
    for job_id in job_ids:
        status = await redis_client.get(f"job:{job_id}:status") or "unknown"
        progress = await redis_client.get(f"job:{job_id}:progress") or "0"
        audio_url = await redis_client.get(f"job:{job_id}:audio_url")
        error = await redis_client.get(f"job:{job_id}:error")

        jobs.append(JobStatus(
            job_id=job_id,
            status=status,
            progress=int(progress),
            audio_url=audio_url,
            error=error,
        ))

    return JobListResponse(jobs=jobs)
