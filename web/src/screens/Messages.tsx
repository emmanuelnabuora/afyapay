import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Message {
  id: string;
  body: string;
  createdAt: string;
}
interface Preferences {
  smsReminders: boolean;
  consentText: { version: string; text: string };
}

export function Messages({ go }: { go: (to: string) => void }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<Message[]>('/me/messages'), api<Preferences>('/me/preferences')])
      .then(([m, p]) => {
        setMessages(m);
        setPrefs(p);
      })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  async function toggle(on: boolean) {
    try {
      setPrefs(await api<Preferences>('/me/preferences', { method: 'POST', body: { smsReminders: on, consentTextVersion: prefs!.consentText.version } }));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!messages || !prefs) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Messages</h1>
      <section className="card">
        <label className="consent">
          <input type="checkbox" checked={prefs.smsReminders} onChange={(e) => toggle(e.target.checked)} />
          <span>{prefs.consentText.text}</span>
        </label>
      </section>
      {messages.length === 0 && <p className="muted">No messages yet.</p>}
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className="card">
            <p>{m.body}</p>
            <time className="hint">{new Date(m.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}</time>
          </li>
        ))}
      </ul>
      <button className="secondary" onClick={() => go('/')}>Back to my policies</button>
    </>
  );
}
