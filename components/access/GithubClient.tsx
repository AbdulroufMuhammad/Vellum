"use client";

import { useEffect, useState } from "react";

type Account = { login: string; name: string | null; avatar: string | null; scopes: string | null; connected_at: string };

const NEW_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Vellum&description=Read+code+for+Vellum+designs&contents=read&metadata=read";

export default function GithubClient() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [envToken, setEnvToken] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/access/github")
      .then((r) => r.json())
      .then((d) => {
        setAccount(d.account ?? null);
        setEnvToken(!!d.envToken);
      })
      .catch(() => setError("Couldn't load the GitHub connection."));
  }, []);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/access/github", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "Couldn't connect.");
    setToken("");
    setAccount(d.account);
  }

  async function disconnect() {
    if (!confirm("Disconnect GitHub? Its token is deleted, and private repositories stop being readable.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/access/github", { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "Couldn't disconnect.");
    setAccount(null);
  }

  return (
    <main className="keys-page">
      <h1>GitHub</h1>
      <p className="muted">
        Connect your GitHub account to base designs on your own code, private repositories included. Only the main access key can use this connection:
        people signed in with a temporary key only see public repositories, even on a project that uses a private one. The token is stored
        encrypted on the server and never shown again.
      </p>

      {account === undefined ? (
        <p className="muted">Loading…</p>
      ) : account ? (
        <div className="gh-account">
          {account.avatar && <img src={account.avatar} alt="" width={40} height={40} />}
          <div>
            <div className="gh-login">
              {account.name ? `${account.name} ` : ""}
              <span className="muted">@{account.login}</span>
            </div>
            <div className="muted">
              Connected {new Date(account.connected_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              {account.scopes ? `, scopes: ${account.scopes}` : ""}
            </div>
          </div>
          <button type="button" className="btn-ghost" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <form className="gh-connect" onSubmit={connect}>
          <ol className="gh-steps">
            <li>
              <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
                Create a fine-grained token on GitHub
              </a>
              . Under <b>Repository access</b>, pick all repositories or just the ones to design from.
            </li>
            <li>
              Under <b>Permissions</b>, set <b>Contents</b> to <i>Read-only</i> (Metadata is read-only already). Nothing more is needed: the app
              only reads code.
            </li>
            <li>Generate it, then paste it here.</li>
          </ol>
          <div className="keys-new-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="gh-token"
            />
            <button type="submit" className="btn-accent" disabled={busy || token.trim().length < 20}>
              {busy ? <span className="spinner" /> : null} Connect
            </button>
          </div>
          {envToken && <p className="muted">A GITHUB_TOKEN is also set on the server; a connected account takes its place.</p>}
        </form>
      )}

      {error && <p className="form-error">{error}</p>}
    </main>
  );
}
