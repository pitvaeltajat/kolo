import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import DoorCard from '@/components/DoorCard';
import HeatingCard from '@/components/HeatingCard';

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <div className="flex flex-col gap-6">
      <DoorCard />
      <HeatingCard />
    </div>
  );
}
