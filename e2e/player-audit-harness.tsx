import React from "react";
import { createRoot } from "react-dom/client";
import PlayerPage from "../src/app/dashboard/player/[id]/page";

const params = Promise.resolve({ id: "audit-book" });
createRoot(document.getElementById("root")!).render(<PlayerPage params={params} />);
