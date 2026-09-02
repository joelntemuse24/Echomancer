"use server";

import { signIn } from "@/lib/auth/authjs";
import {
  GoogleAuthNotConfiguredError,
  isGoogleOAuthConfigured,
} from "@/lib/auth/google";

export async function signInWithGoogle(callbackUrl?: string): Promise<void> {
  if (!isGoogleOAuthConfigured()) {
    throw new GoogleAuthNotConfiguredError();
  }
  await signIn("google", {
    redirectTo: callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/dashboard/queue",
  });
}
