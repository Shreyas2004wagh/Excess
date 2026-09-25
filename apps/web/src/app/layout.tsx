import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Excess — The practice advantage',
    template: '%s · Excess',
  },
  description:
    'Build your trading process with live BTC and ETH markets, $10,000 in virtual funds, and a workspace made for deliberate practice.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable}`}
      data-scroll-behavior="smooth"
    >
      <body>
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: '#b6ed72',
              colorPrimaryForeground: '#16200d',
              colorBackground: '#14171c',
              colorForeground: '#eff1ed',
              colorMuted: '#1a1e24',
              colorMutedForeground: '#9ba3af',
              colorInput: '#0c0e11',
              colorInputForeground: '#eff1ed',
              colorNeutral: '#ffffff',
              colorBorder: '#282d35',
              colorRing: '#b6ed72',
              colorDanger: '#f38a9b',
              fontFamily: 'var(--font-geist), sans-serif',
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
