import { SignIn } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { AuthLoading, AuthShell } from '../../../components/auth-shell';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <AuthShell>
      <SignIn forceRedirectUrl="/dashboard" fallback={<AuthLoading />} />
    </AuthShell>
  );
}
