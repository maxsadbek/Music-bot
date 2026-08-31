import React from 'react';

export const metadata = {
  title: 'Musify - Instagram Reel Music Finder Telegram Bot',
  description: 'Production-ready Telegram Bot to recognize music and songs from Instagram Reels.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        margin: 0,
        padding: 0,
        backgroundColor: '#0f172a',
        color: '#f8fafc',
      }}>
        {children}
      </body>
    </html>
  );
}
