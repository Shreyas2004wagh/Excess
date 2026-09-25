'use client';

import { PageState } from '../../components/page-state';

export default function Error({ retry }: { retry: () => void }) {
  return (
    <PageState
      title="The trading terminal could not load."
      message="Your account is unaffected. Retry the connection to reconnect to the market."
      action={retry}
    />
  );
}
