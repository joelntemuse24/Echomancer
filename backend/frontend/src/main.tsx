import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import "./index.css";
import { ClerkProviderWrapper } from "./lib/clerk.tsx";

// Create QueryClient with default options
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000,
    },
  },
});

// Root component with providers
function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <ClerkProviderWrapper>
        <App />
      </ClerkProviderWrapper>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
