import { SignUp } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { AuthLoading, AuthShell } from '../../../components/auth-shell';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp forceRedirectUrl="/dashboard" fallback={<AuthLoading />} />
    </AuthShell>
  );
}
