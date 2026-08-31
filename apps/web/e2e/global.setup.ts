import { createClerkClient } from '@clerk/backend';
import { clerkSetup } from '@clerk/testing/playwright';
import { test as setup } from '@playwright/test';

setup.describe.configure({ mode: 'serial' });

setup('configure Clerk testing', async () => {
  process.env.CLERK_PUBLISHABLE_KEY ??=
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  const secretKey = process.env.CLERK_SECRET_KEY;
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!secretKey || !process.env.CLERK_PUBLISHABLE_KEY || !email) {
    throw new Error(
      'Clerk E2E credentials and E2E_CLERK_USER_EMAIL are required',
    );
  }

  const clerkClient = createClerkClient({ secretKey });
  const existingUsers = await clerkClient.users.getUserList({
    emailAddress: [email],
  });
  if (existingUsers.totalCount === 0) {
    await clerkClient.users.createUser({
      emailAddress: [email],
      firstName: 'Excess',
      lastName: 'Tester',
      skipPasswordRequirement: true,
    });
  }

  await clerkSetup();
});
