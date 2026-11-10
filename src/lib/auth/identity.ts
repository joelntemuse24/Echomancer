import { cookies } from "next/headers";
import { isEmailLoginConfigured } from "@/lib/auth/email-login";
import { getUserById, isGoogleOAuthConfigured } from "@/lib/auth/google";
import {
  SESSION_COOKIE,
  isDurableUserId,
  verifySessionToken,
} from "@/lib/auth/session";

export type ViewerIdentity =
  | { signedIn: false; googleEnabled: boolean; emailEnabled: boolean }
  | {
      signedIn: true;
      googleEnabled: boolean;
      emailEnabled: boolean;
      name: string | null;
      email: string | null;
      image: string | null;
    };

export async function getViewerIdentity(): Promise<ViewerIdentity> {
  const googleEnabled = isGoogleOAuthConfigured();
  const emailEnabled = isEmailLoginConfigured();
  if (!process.env.TURSO_DATABASE_URL) {
    return { signedIn: false, googleEnabled, emailEnabled };
  }
  try {
    // No schema migration here. Home and sign-in only need the cookie, and
    // a signed-in lookup goes through getUserById, which migrates itself.
    // Running the jobs migrator first made every screen wait on Turso.
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const session = await verifySessionToken(token);
    if (!session || !isDurableUserId(session.userId)) {
      return { signedIn: false, googleEnabled, emailEnabled };
    }
    const user = await getUserById(session.userId);
    return {
      signedIn: true,
      googleEnabled,
      emailEnabled,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
    };
  } catch {
    return { signedIn: false, googleEnabled, emailEnabled };
  }
}
