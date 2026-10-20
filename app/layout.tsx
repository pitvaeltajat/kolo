import type { Metadata, Viewport } from 'next';
import './globals.css';
import Providers from '@/components/Providers';
import TopBar from '@/components/TopBar';

export const metadata: Metadata = {
  title: 'Kolo',
  description: 'PitVan kolon oven ja lämmityksen ohjaus',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#1f6f43',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fi" suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>
          <TopBar />
          <main className="shell">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
