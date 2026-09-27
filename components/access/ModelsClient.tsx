"use client";

import { useEffect, useState } from "react";

type Model = { key: string; label: string; note: string };

export default function ModelsClient() {
  const [all, setAll] = useState<Model[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/access/models")
      .then((r) => r.json())
      .then((data) => {
        setAll(data.all ?? []);
        setEnabled(new Set(data.enabled ?? []));
      })
      .catch(() => setError("Couldn't load models."));
  }, []);

  function toggle(key: string) {
    setSaved(false);
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/access/models", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [...enabled] }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) return setError(data.error ?? "Couldn't save.");
    setEnabled(new Set(data.enabled));
    setSaved(true);
  }

  return (
    <main className="keys-page">
      <h1>Models</h1>
      <p className="muted">
        Choose which models show up in the Model picker when starting or editing a project. At least one must stay enabled. This applies to every
        project; it doesn&apos;t change a project&apos;s model once it&apos;s already picked one.
      </p>

      {all == null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="models-list">
          {all.map((m) => (
            <label key={m.key} className="models-row">
              <input type="checkbox" checked={enabled.has(m.key)} onChange={() => toggle(m.key)} />
              <span className="models-name">{m.label}</span>
              <span className="muted">{m.note}</span>
            </label>
          ))}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="keys-new-row">
        <button type="button" className="btn-accent" disabled={saving || all == null} onClick={save}>
          {saving ? <span className="spinner" /> : null} Save
        </button>
        {saved && <span className="muted">Saved.</span>}
      </div>
    </main>
  );
}
