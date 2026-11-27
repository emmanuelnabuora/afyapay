import { FormEvent, ReactNode, useState } from 'react';
import type { ApiError } from './api';

/** Runs an action with a busy flag and the API's own error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>, e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label="Results" tabIndex={0}>
      <table className="grid">
        <thead>{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A file picker plus send button; clears itself after a successful send. */
export function FilePick({ id, label, accept, hint, button, disabled, onSend }: { id: string; label: string; accept: string; hint?: ReactNode; button: string; disabled?: boolean; onSend: (f: File) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState(0);
  const a = useAction();
  return (
    <form onSubmit={(e) => a.run(async () => { await onSend(file!); setFile(null); setKey(key + 1); }, e)}>
      <label htmlFor={id}>{label}</label>
      <input key={key} id={id} type="file" accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
      {hint && <p className="hint">{hint}</p>}
      <ErrorLine error={a.error} />
      <button className="primary inline top-gap" disabled={a.busy || !file || disabled}>{a.busy ? 'Sending…' : button}</button>
    </form>
  );
}

export const who = (userId: string | null, me: string) => (!userId ? '—' : userId === me ? 'You' : 'A colleague');
