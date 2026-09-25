'use client';

import { PageState } from '../../components/page-state';

export default function Error({ retry }: { retry: () => void }) {
  return (
    <PageState
      title="Your account could not be loaded."
      message="Retry the connection to return to your account overview."
      action={retry}
    />
  );
}
