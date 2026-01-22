from fastapi import APIRouter, HTTPException, Depends, Request, Header
from pydantic import BaseModel
from typing import Optional
import hmac
import hashlib
import httpx

from ..config import get_settings, Settings

router = APIRouter(prefix="/payment", tags=["Payment"])


class CheckoutRequest(BaseModel):
    price_id: str
    user_id: str
    user_email: str
    success_url: str
    cancel_url: Optional[str] = None


class CheckoutResponse(BaseModel):
    checkout_url: str


class SubscriptionStatus(BaseModel):
    has_subscription: bool
    subscription_type: Optional[str] = None  # "one_time" or "subscription"
    expires_at: Optional[str] = None


@router.post("/checkout/one-time", response_model=CheckoutResponse)
async def create_one_time_checkout(
    request: CheckoutRequest,
    settings: Settings = Depends(get_settings),
):
    """Create a one-time payment checkout session."""
    return await create_checkout(
        price_id=settings.paddle_one_time_price_id,
        user_id=request.user_id,
        user_email=request.user_email,
        success_url=request.success_url,
        cancel_url=request.cancel_url,
        settings=settings,
    )


@router.post("/checkout/subscription", response_model=CheckoutResponse)
async def create_subscription_checkout(
    request: CheckoutRequest,
    settings: Settings = Depends(get_settings),
):
    """Create a subscription checkout session."""
    return await create_checkout(
        price_id=settings.paddle_subscription_price_id,
        user_id=request.user_id,
        user_email=request.user_email,
        success_url=request.success_url,
        cancel_url=request.cancel_url,
        settings=settings,
    )


async def create_checkout(
    price_id: str,
    user_id: str,
    user_email: str,
    success_url: str,
    cancel_url: Optional[str],
    settings: Settings,
) -> CheckoutResponse:
    """Create a Paddle checkout session."""
    if not settings.paddle_api_key:
        raise HTTPException(
            status_code=503,
            detail="Payment system not configured"
        )

    # Paddle API endpoint
    base_url = (
        "https://sandbox-api.paddle.com"
        if settings.paddle_environment == "sandbox"
        else "https://api.paddle.com"
    )

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{base_url}/transactions",
            headers={
                "Authorization": f"Bearer {settings.paddle_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "items": [{"price_id": price_id, "quantity": 1}],
                "customer": {"email": user_email},
                "custom_data": {"user_id": user_id},
                "checkout": {
                    "url": success_url,
                },
            },
        )

        if response.status_code != 200 and response.status_code != 201:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to create checkout: {response.text}"
            )

        data = response.json()
        checkout_url = data.get("data", {}).get("checkout", {}).get("url")

        if not checkout_url:
            raise HTTPException(
                status_code=500,
                detail="No checkout URL returned from Paddle"
            )

        return CheckoutResponse(checkout_url=checkout_url)


@router.post("/webhook")
async def handle_webhook(
    request: Request,
    paddle_signature: Optional[str] = Header(None, alias="Paddle-Signature"),
    settings: Settings = Depends(get_settings),
):
    """
    Handle Paddle webhook events.

    Events:
    - transaction.completed: Payment successful
    - subscription.created: New subscription
    - subscription.canceled: Subscription canceled
    """
    body = await request.body()

    # Verify webhook signature
    if settings.paddle_webhook_secret and paddle_signature:
        if not verify_paddle_signature(body, paddle_signature, settings.paddle_webhook_secret):
            raise HTTPException(status_code=401, detail="Invalid signature")

    data = await request.json()
    event_type = data.get("event_type")
    event_data = data.get("data", {})

    if event_type == "transaction.completed":
        # Payment successful
        custom_data = event_data.get("custom_data", {})
        user_id = custom_data.get("user_id")

        if user_id:
            # TODO: Store payment/subscription status in database
            # For now, you'd use Redis or add a database
            print(f"Payment completed for user: {user_id}")

    elif event_type == "subscription.created":
        custom_data = event_data.get("custom_data", {})
        user_id = custom_data.get("user_id")
        print(f"Subscription created for user: {user_id}")

    elif event_type == "subscription.canceled":
        custom_data = event_data.get("custom_data", {})
        user_id = custom_data.get("user_id")
        print(f"Subscription canceled for user: {user_id}")

    return {"received": True}


def verify_paddle_signature(body: bytes, signature: str, secret: str) -> bool:
    """Verify Paddle webhook signature."""
    try:
        # Parse the signature header
        # Format: ts=timestamp;h1=hash
        parts = dict(part.split("=") for part in signature.split(";"))
        timestamp = parts.get("ts", "")
        received_hash = parts.get("h1", "")

        # Compute expected hash
        signed_payload = f"{timestamp}:{body.decode()}"
        expected_hash = hmac.new(
            secret.encode(),
            signed_payload.encode(),
            hashlib.sha256
        ).hexdigest()

        return hmac.compare_digest(expected_hash, received_hash)
    except Exception:
        return False


@router.get("/subscription-status", response_model=SubscriptionStatus)
async def get_subscription_status(
    user_id: str = "dev-user",  # Would come from auth in production
    settings: Settings = Depends(get_settings),
):
    """
    Get subscription status for a user.

    Note: In production, this would query a database.
    For now, returns a placeholder.
    """
    # TODO: Implement proper subscription status tracking
    # This would require a database to persist subscription state
    return SubscriptionStatus(
        has_subscription=False,
        subscription_type=None,
        expires_at=None,
    )
