import './globals.css';

export const metadata = {
  title: 'Pivot Leads',
  description: 'Find, verify & reach decision-makers — compliant sourcing, real email verification, and AI outreach.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}