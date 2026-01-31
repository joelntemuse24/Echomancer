"""
Stripe payment integration for Echomancer.
Handles one-time purchases and subscriptions.
"""
from fastapi import APIRouter, HTTPException, Request, Header
from pydantic import BaseModel
from typing import Optional
import httpx
import hmac
import hashlib

from ..config import get_settings
from ..services import database as db

settings = get_settings()
router = APIRouter(prefix="/payments", tags=["Payments"])


class CreateCheckoutRequest(BaseModel):
    user_email: str
    price_type: str = "one_time"  # "one_time" or "subscription"
    success_url: str = ""
    cancel_url: str = ""


class CheckoutResponse(BaseModel):
    checkout_url: str
    session_id: str


class CreditBalanceResponse(BaseModel):
    credits: int
    email: str


@router.post("/create-checkout", response_model=CheckoutResponse)
async def create_checkout_session(request: CreateCheckoutRequest):
    """
    Create a Stripe Checkout session for purchasing credits.
    
    - one_time: Buy a single audiobook credit
    - subscription: Monthly subscription with unlimited audiobooks
    """
    if not settings.stripe_secret_key:
        raise HTTPException(
            status_code=503,
            detail="Payment system not configured. Set STRIPE_SECRET_KEY in environment."
        )
    
    # Determine price ID
    if request.price_type == "subscription":
        price_id = settings.stripe_price_id_subscription
    else:
        price_id = settings.stripe_price_id_one_time
    
    if not price_id:
        raise HTTPException(
            status_code=503,
            detail=f"Price ID for {request.price_type} not configured"
        )
    
    # Default URLs
    base_url = settings.frontend_url
    success_url = request.success_url or f"{base_url}/payment/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = request.cancel_url or f"{base_url}/payment/cancelled"
    
    # Create Stripe checkout session
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.stripe.com/v1/checkout/sessions",
            auth=(settings.stripe_secret_key, ""),
            data={
                "mode": "subscription" if request.price_type == "subscription" else "payment",
                "line_items[0][price]": price_id,
                "line_items[0][quantity]": 1,
                "customer_email": request.user_email,
                "success_url": success_url,
                "cancel_url": cancel_url,
                "metadata[user_email]": request.user_email,
                "metadata[price_type]": request.price_type,
            }
        )
        
        if response.status_code != 200:
            error_data = response.json()
            raise HTTPException(
                status_code=500,
                detail=f"Stripe error: {error_data.get('error', {}).get('message', 'Unknown error')}"
            )
        
        session = response.json()
        
        return CheckoutResponse(
            checkout_url=session["url"],
            session_id=session["id"]
        )


@router.post("/webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: Optional[str] = Header(None, alias="Stripe-Signature")
):
    """
    Handle Stripe webhook events.
    
    Events handled:
    - checkout.session.completed: Payment successful
    - customer.subscription.created: New subscription
    - customer.subscription.deleted: Subscription cancelled
    """
    body = await request.body()
    
    # Verify webhook signature if secret is configured
    if settings.stripe_webhook_secret and stripe_signature:
        if not verify_stripe_signature(body, stripe_signature, settings.stripe_webhook_secret):
            raise HTTPException(status_code=401, detail="Invalid signature")
    
    event = await request.json()
    event_type = event.get("type")
    data = event.get("data", {}).get("object", {})
    
    if event_type == "checkout.session.completed":
        # Payment successful - add credits
        metadata = data.get("metadata", {})
        user_email = metadata.get("user_email") or data.get("customer_email")
        price_type = metadata.get("price_type", "one_time")
        
        if user_email:
            # Get or create user
            user = await db.get_or_create_user(user_email)
            
            if price_type == "subscription":
                # Subscription gives unlimited credits (set high number)
                await db.add_credits(user["id"], 1000)
                await db.log_usage(user["id"], "subscription_started", cost_usd=0)
            else:
                # One-time purchase adds 1 credit
                await db.add_credits(user["id"], 1)
                await db.log_usage(user["id"], "credit_purchased", cost_usd=float(data.get("amount_total", 0)) / 100)
            
            print(f"Payment completed for {user_email}: {price_type}")
    
    elif event_type == "customer.subscription.deleted":
        # Subscription cancelled - don't remove existing credits, just stop adding new ones
        customer_email = data.get("customer_email")
        if customer_email:
            user = await db.get_or_create_user(customer_email)
            await db.log_usage(user["id"], "subscription_cancelled", cost_usd=0)
            print(f"Subscription cancelled for {customer_email}")
    
    return {"received": True}


def verify_stripe_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify Stripe webhook signature."""
    try:
        # Parse signature header
        parts = dict(item.split("=") for item in signature.split(","))
        timestamp = parts.get("t", "")
        received_sig = parts.get("v1", "")
        
        # Compute expected signature
        signed_payload = f"{timestamp}.{payload.decode()}"
        expected_sig = hmac.new(
            secret.encode(),
            signed_payload.encode(),
            hashlib.sha256
        ).hexdigest()
        
        return hmac.compare_digest(expected_sig, received_sig)
    except Exception:
        return False


@router.get("/credits/{email}", response_model=CreditBalanceResponse)
async def get_credits(email: str):
    """Get credit balance for a user."""
    user = await db.get_or_create_user(email)
    return CreditBalanceResponse(
        credits=user.get("credits", 0),
        email=email
    )


@router.get("/config")
async def get_payment_config():
    """Get public payment configuration for frontend."""
    return {
        "publishable_key": settings.stripe_publishable_key,
        "is_configured": bool(settings.stripe_secret_key),
        "has_one_time_price": bool(settings.stripe_price_id_one_time),
        "has_subscription_price": bool(settings.stripe_price_id_subscription),
    }
