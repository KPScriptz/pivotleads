import { redirect } from 'next/navigation';

export default function RootPage() {
  // Route any visitor from / straight to the working /campaign view.
  redirect('/campaign');
}
