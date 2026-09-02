import { cookies } from "next/headers";
import { getUserById, isGoogleOAuthConfigured } from "@/lib/auth/google";
import {
  SESSION_COOKIE,
  isDurableUserId,
  verifySessionToken,
} from "@/lib/auth/session";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";

export type ViewerIdentity =
  | { signedIn: false; googleEnabled: boolean }
  | {
      signedIn: true;
      googleEnabled: boolean;
      name: string | null;
      email: string | null;
      image: string | null;
    };

export async function getViewerIdentity(): Promise<ViewerIdentity> {
  const googleEnabled = isGoogleOAuthConfigured();
  try {
    await ensureTtsJobColumns();
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const session = await verifySessionToken(token);
    if (!session || !isDurableUserId(session.userId)) {
      return { signedIn: false, googleEnabled };
    }
    const user = await getUserById(session.userId);
    return {
      signedIn: true,
      googleEnabled,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
    };
  } catch {
    return { signedIn: false, googleEnabled };
  }
}
