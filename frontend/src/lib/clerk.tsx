import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import { useEffect } from 'react';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || '';

// If no Clerk key, skip Clerk and render children directly
const hasClerkKey = CLERK_PUBLISHABLE_KEY && CLERK_PUBLISHABLE_KEY !== 'pk_test_placeholder' && !CLERK_PUBLISHABLE_KEY.includes('placeholder');

export function ClerkProviderWrapper({ children }: { children: React.ReactNode }) {
  // If no valid Clerk key, render without Clerk
  if (!hasClerkKey) {
    console.warn('Clerk publishable key not configured. Running without authentication.');
    return <>{children}</>;
  }

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <AuthTokenSync />
      {children}
    </ClerkProvider>
  );
}

function AuthTokenSync() {
  const { getToken } = useAuth();

  useEffect(() => {
    const syncToken = async () => {
      try {
        const token = await getToken();
        if (token) {
          localStorage.setItem('clerk_token', token);
        } else {
          localStorage.removeItem('clerk_token');
        }
      } catch (error) {
        console.error('Token sync error:', error);
      }
    };

    syncToken();
    // Sync token every 5 minutes
    const interval = setInterval(syncToken, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, [getToken]);

  return null;
}

