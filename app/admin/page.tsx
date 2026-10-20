import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import AdminTags from '@/components/AdminTags';

export default async function Admin() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Fine-grained admin authorisation is enforced by the API (requireAdmin);
  // the page just renders and surfaces a 403 if the caller isn't allowed.
  return <AdminTags />;
}
