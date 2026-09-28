'use client';

import { PageState } from '../../../components/page-state';

export default function Error({ retry }: { retry: () => void }) {
  return (
    <PageState
      title="Audit activity could not be loaded."
      message="Retry the connection to return to the audit explorer."
      action={retry}
    />
  );
}
