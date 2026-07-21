import './globals.css';

export const metadata = {
  title: 'Origami UI Pipeline',
  description: 'Lead generation and scraping dashboard',
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