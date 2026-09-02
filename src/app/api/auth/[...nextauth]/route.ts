import { NextRequest } from "next/server";
import { handleAuthRequest } from "@/lib/auth/authjs";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ nextauth?: string[] }> };

export async function GET(request: NextRequest, _context: RouteContext) {
  return handleAuthRequest(request, "GET");
}

export async function POST(request: NextRequest, _context: RouteContext) {
  return handleAuthRequest(request, "POST");
}
