import httpx
from pathlib import Path
from typing import Optional
import uuid


class BunnyStorage:
    """Bunny.net CDN storage client."""

    def __init__(self, storage_zone: str, api_key: str, cdn_url: str):
        self.storage_zone = storage_zone
        self.api_key = api_key
        self.cdn_url = cdn_url.rstrip("/")
        self.storage_url = f"https://storage.bunnycdn.com/{storage_zone}"

    async def upload_file(
        self,
        file_path: Path,
        remote_path: Optional[str] = None
    ) -> str:
        """
        Upload a file to Bunny.net storage.

        Args:
            file_path: Local path to the file
            remote_path: Remote path in storage (optional, generates UUID if not provided)

        Returns:
            CDN URL of the uploaded file
        """
        if remote_path is None:
            ext = file_path.suffix
            remote_path = f"{uuid.uuid4()}{ext}"

        upload_url = f"{self.storage_url}/{remote_path}"

        async with httpx.AsyncClient() as client:
            with open(file_path, "rb") as f:
                response = await client.put(
                    upload_url,
                    content=f.read(),
                    headers={"AccessKey": self.api_key},
                    timeout=300.0,
                )
                response.raise_for_status()

        return f"{self.cdn_url}/{remote_path}"

    async def upload_bytes(
        self,
        content: bytes,
        remote_path: str
    ) -> str:
        """
        Upload bytes to Bunny.net storage.

        Args:
            content: File content as bytes
            remote_path: Remote path in storage

        Returns:
            CDN URL of the uploaded file
        """
        upload_url = f"{self.storage_url}/{remote_path}"

        async with httpx.AsyncClient() as client:
            response = await client.put(
                upload_url,
                content=content,
                headers={"AccessKey": self.api_key},
                timeout=300.0,
            )
            response.raise_for_status()

        return f"{self.cdn_url}/{remote_path}"

    async def delete_file(self, remote_path: str) -> bool:
        """
        Delete a file from Bunny.net storage.

        Args:
            remote_path: Remote path of the file to delete

        Returns:
            True if deleted successfully
        """
        delete_url = f"{self.storage_url}/{remote_path}"

        async with httpx.AsyncClient() as client:
            response = await client.delete(
                delete_url,
                headers={"AccessKey": self.api_key},
            )
            return response.status_code == 200

    async def file_exists(self, remote_path: str) -> bool:
        """Check if a file exists in storage."""
        check_url = f"{self.cdn_url}/{remote_path}"

        async with httpx.AsyncClient() as client:
            response = await client.head(check_url)
            return response.status_code == 200


def get_bunny_client(storage_zone: str, api_key: str, cdn_url: str) -> Optional[BunnyStorage]:
    """Factory function to get Bunny storage client."""
    # Check for empty values or placeholder values
    placeholder_values = ["your_storage_zone", "your_bunny_api_key_here", "https://your-zone.b-cdn.net"]
    if not all([storage_zone, api_key, cdn_url]) or any(val in placeholder_values for val in [storage_zone, api_key, cdn_url]):
        return None
    return BunnyStorage(storage_zone, api_key, cdn_url)
