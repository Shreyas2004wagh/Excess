'use client';

import { PageState } from '../../components/page-state';

export default function Error({ retry }: { retry: () => void }) {
  return (
    <PageState
      title="Your report could not be loaded."
      message="Your trades and account records are unchanged. Retry the connection."
      action={retry}
    />
  );
}
