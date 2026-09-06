import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../app/AuthContext';

function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="mark" aria-hidden="true">
          T
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        {children}
      </section>
    </main>
  );
}
export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login({ email, password });
      await refresh();
      const target = (location.state as { from?: string } | null)?.from ?? '/vaults';
      navigate(target, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Welcome back" subtitle="Sign in to browse your mirrored vaults.">
      <form onSubmit={submit}>
        <label>
          Email
          <input
            autoComplete="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ marginTop: "1rem", textAlign: "center", fontSize: "0.875rem" }}>
          Setting up for the first time? <Link to="/setup">Set up Tephra</Link>
        </p>
      </form>
    </AuthFrame>
  );
}
export function SetupPage() {
  const [values, setValues] = useState({ email: '', password: '', bootstrapToken: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.bootstrap(values);
      await refresh();
      navigate('/vaults', { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame
      title="Set up Tephra"
      subtitle="Create the first administrator account for this server."
    >
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={values.email}
            onChange={(e) => setValues({ ...values, email: e.target.value })}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            minLength={10}
            autoComplete="new-password"
            required
            value={values.password}
            onChange={(e) => setValues({ ...values, password: e.target.value })}
          />
        </label>
        <label>
          Bootstrap token
          <input
            type="password"
            autoComplete="off"
            required
            value={values.bootstrapToken}
            onChange={(e) => setValues({ ...values, bootstrapToken: e.target.value })}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Creating account…' : 'Create administrator'}
        </button>
      </form>
    </AuthFrame>
  );
}
