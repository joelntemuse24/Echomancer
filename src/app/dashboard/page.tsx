import { redirect } from "next/navigation";
import { VOICES_HREF } from "@/lib/nav/routes";

export default function DashboardPage() {
  redirect(VOICES_HREF);
}
