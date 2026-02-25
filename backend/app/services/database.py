"""
Supabase database service for Echomancer.
Handles users, voices, audiobooks, and usage tracking.
"""
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta
import httpx
from ..config import get_settings

settings = get_settings()


class SupabaseClient:
    """Simple Supabase REST client."""
    
    def __init__(self):
        self.url = settings.supabase_url
        self.key = settings.supabase_service_key or settings.supabase_anon_key
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
    
    @property
    def is_configured(self) -> bool:
        return bool(self.url and self.key)
    
    async def _request(self, method: str, table: str, params: dict = None, data: dict = None) -> dict:
        """Make a request to Supabase REST API."""
        if not self.is_configured:
            return {"error": "Supabase not configured"}
        
        url = f"{self.url}/rest/v1/{table}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(
                method=method,
                url=url,
                headers=self.headers,
                params=params,
                json=data
            )
            
            if response.status_code >= 400:
                return {"error": response.text}
            
            if response.content:
                return response.json()
            return {"success": True}
    
    async def insert(self, table: str, data: dict) -> dict:
        return await self._request("POST", table, data=data)
    
    async def select(self, table: str, filters: dict = None) -> list:
        params = {"select": "*"}
        if filters:
            for key, value in filters.items():
                params[key] = f"eq.{value}"
        result = await self._request("GET", table, params=params)
        return result if isinstance(result, list) else []
    
    async def update(self, table: str, filters: dict, data: dict) -> dict:
        params = {}
        for key, value in filters.items():
            params[key] = f"eq.{value}"
        return await self._request("PATCH", table, params=params, data=data)
    
    async def delete(self, table: str, filters: dict) -> dict:
        params = {}
        for key, value in filters.items():
            params[key] = f"eq.{value}"
        return await self._request("DELETE", table, params=params)


# Singleton client
_db: Optional[SupabaseClient] = None

def get_db() -> SupabaseClient:
    global _db
    if _db is None:
        _db = SupabaseClient()
    return _db


# ============== User Operations ==============

async def get_or_create_user(email: str, name: str = "") -> dict:
    """Get existing user or create new one."""
    db = get_db()
    if not db.is_configured:
        return {"id": "local-user", "email": email, "credits": 999}
    
    users = await db.select("users", {"email": email})
    if users:
        return users[0]
    
    new_user = {
        "email": email,
        "name": name,
        "credits": 1,  # Start with 1 free audiobook
        "created_at": datetime.utcnow().isoformat()
    }
    result = await db.insert("users", new_user)
    return result[0] if isinstance(result, list) else new_user


async def get_user_credits(user_id: str) -> int:
    """Get user's remaining credits."""
    db = get_db()
    if not db.is_configured:
        return 999
    
    users = await db.select("users", {"id": user_id})
    return users[0].get("credits", 0) if users else 0


async def deduct_credit(user_id: str) -> bool:
    """Deduct one credit from user. Returns False if insufficient credits."""
    db = get_db()
    if not db.is_configured:
        return True
    
    credits = await get_user_credits(user_id)
    if credits <= 0:
        return False
    
    await db.update("users", {"id": user_id}, {"credits": credits - 1})
    return True


async def add_credits(user_id: str, amount: int) -> int:
    """Add credits to user account. Returns new balance."""
    db = get_db()
    if not db.is_configured:
        return 999
    
    current = await get_user_credits(user_id)
    new_balance = current + amount
    await db.update("users", {"id": user_id}, {"credits": new_balance})
    return new_balance


# ============== Voice Operations ==============

async def save_voice(user_id: str, voice_id: str, name: str, provider: str = "replicate") -> dict:
    """Save a cloned voice for reuse."""
    db = get_db()
    if not db.is_configured:
        return {"id": voice_id, "user_id": user_id, "name": name}
    
    voice = {
        "user_id": user_id,
        "voice_id": voice_id,
        "name": name,
        "provider": provider,
        "created_at": datetime.utcnow().isoformat()
    }
    result = await db.insert("voices", voice)
    return result[0] if isinstance(result, list) else voice


async def get_user_voices(user_id: str) -> list:
    """Get all saved voices for a user."""
    db = get_db()
    if not db.is_configured:
        return []
    
    return await db.select("voices", {"user_id": user_id})


async def get_voice(voice_id: str) -> Optional[dict]:
    """Get a specific voice by ID."""
    db = get_db()
    if not db.is_configured:
        return None
    
    voices = await db.select("voices", {"voice_id": voice_id})
    return voices[0] if voices else None


# ============== Audiobook Operations ==============

async def create_audiobook_record(
    user_id: str,
    title: str,
    voice_id: str,
    status: str = "processing"
) -> dict:
    """Create a new audiobook record."""
    db = get_db()
    
    audiobook = {
        "user_id": user_id,
        "title": title,
        "voice_id": voice_id,
        "status": status,
        "created_at": datetime.utcnow().isoformat()
    }
    
    if not db.is_configured:
        audiobook["id"] = f"local-{datetime.utcnow().timestamp()}"
        return audiobook
    
    result = await db.insert("audiobooks", audiobook)
    return result[0] if isinstance(result, list) else audiobook


async def update_audiobook_status(
    audiobook_id: str,
    status: str,
    audio_url: str = None,
    error: str = None
) -> dict:
    """Update audiobook processing status."""
    db = get_db()
    if not db.is_configured:
        return {"id": audiobook_id, "status": status}
    
    data = {"status": status, "updated_at": datetime.utcnow().isoformat()}
    if audio_url:
        data["audio_url"] = audio_url
    if error:
        data["error"] = error
    
    return await db.update("audiobooks", {"id": audiobook_id}, data)


async def get_user_audiobooks(user_id: str, limit: int = 20) -> list:
    """Get user's audiobook history."""
    db = get_db()
    if not db.is_configured:
        return []
    
    return await db.select("audiobooks", {"user_id": user_id})


# ============== Usage Tracking ==============

async def log_usage(
    user_id: str,
    action: str,
    chars_processed: int = 0,
    cost_usd: float = 0,
    provider: str = "replicate"
) -> dict:
    """Log usage for analytics and billing."""
    db = get_db()
    
    usage = {
        "user_id": user_id,
        "action": action,
        "chars_processed": chars_processed,
        "cost_usd": cost_usd,
        "provider": provider,
        "created_at": datetime.utcnow().isoformat()
    }
    
    if not db.is_configured:
        return usage
    
    result = await db.insert("usage_logs", usage)
    return result[0] if isinstance(result, list) else usage


async def get_user_usage_stats(user_id: str, days: int = 30) -> dict:
    """Get usage statistics for a user."""
    db = get_db()
    if not db.is_configured:
        return {"total_chars": 0, "total_cost": 0, "audiobooks_created": 0}
    
    # This would be a more complex query in production
    # For now, return placeholder
    return {
        "total_chars": 0,
        "total_cost": 0.0,
        "audiobooks_created": 0,
        "period_days": days
    }
