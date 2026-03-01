import { NextResponse } from "next/server";
import { ZodError, type ZodIssue } from "zod";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.statusCode }
    );
  }

  if (error instanceof ZodError) {
    const issues: ZodIssue[] = error.issues;
    const messages = issues.map((e) => `${e.path.join(".")}: ${e.message}`);
    return NextResponse.json(
      { error: "Validation failed", details: messages },
      { status: 400 }
    );
  }

  if (error instanceof Error) {
    console.error(`[API Error] ${error.message}`, error.stack);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  console.error("[API Error] Unknown error:", error);
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}
