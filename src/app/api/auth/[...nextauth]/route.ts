import { NextRequest } from "next/server";
import { handleAuthRequest } from "@/lib/auth/authjs";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return handleAuthRequest(request, "GET");
}

export async function POST(request: NextRequest) {
  return handleAuthRequest(request, "POST");
}
