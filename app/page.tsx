import React from 'react';

export default function HomePage() {
  return (
    <main style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '2rem',
      textAlign: 'center',
    }}>
      <div style={{
        backgroundColor: '#1e293b',
        padding: '3rem 2.5rem',
        borderRadius: '1.5rem',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        maxWidth: '550px',
        width: '100%',
        border: '1px solid #334155',
      }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🎵</div>
        <h1 style={{ fontSize: '2.25rem', fontWeight: 800, marginBottom: '0.75rem', background: 'linear-gradient(to right, #ec4899, #8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Musify Bot
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '1.1rem', marginBottom: '2rem', lineHeight: '1.6' }}>
          Instagram Reel Music Finder Telegram Bot built for Vercel Serverless Functions.
        </p>

        <div style={{
          backgroundColor: '#0f172a',
          padding: '1.25rem',
          borderRadius: '0.75rem',
          border: '1px solid #334155',
          marginBottom: '2rem',
          textAlign: 'left',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ height: '10px', width: '10px', backgroundColor: '#22c55e', borderRadius: '50%', display: 'inline-block', marginRight: '0.5rem' }}></span>
            <strong style={{ color: '#e2e8f0', fontSize: '0.95rem' }}>Webhook Endpoint Status: Active</strong>
          </div>
          <code style={{ color: '#38bdf8', fontSize: '0.85rem', wordBreak: 'break-all' }}>
            POST /api/telegram/webhook
          </code>
        </div>

        <a
          href="https://t.me/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            backgroundColor: '#6366f1',
            color: '#ffffff',
            fontWeight: 600,
            padding: '0.875rem 2rem',
            borderRadius: '9999px',
            textDecoration: 'none',
            fontSize: '1rem',
            transition: 'background-color 0.2s ease',
          }}
        >
          Open in Telegram 🚀
        </a>
      </div>
    </main>
  );
}
