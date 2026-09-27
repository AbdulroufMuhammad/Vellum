"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Popover from "@/components/ui/Popover";
import { googleFontsHref, type DesignSystem } from "@/lib/designSystems";
import type { ModelKey } from "@/lib/gateway";
import { IconCheck, IconChevronDown, IconClose, IconCode, IconFeather, IconGithub, IconList, IconPlus, IconSearch } from "@/components/ui/Icons";

export type ModelOption = { key: ModelKey; label: string; note: string };

const pick = (ds: DesignSystem, names: string[], fallback: string) =>
  ds.colors.find((c) => names.includes(c.name.toLowerCase()))?.hex ?? fallback;

export function DesignSystemFonts({ systems }: { systems: DesignSystem[] }) {
  const hrefs = useMemo(() => [...new Set(systems.map(googleFontsHref).filter((h): h is string => !!h))], [systems]);
  return (
    <>
      {hrefs.map((h) => (
        <link key={h} rel="stylesheet" href={h} />
      ))}
    </>
  );
}

/** A little specimen of a design system: its type, palette and a button. */
export function DesignSystemCard({ ds, selected, badge, onClick }: { ds: DesignSystem; selected?: boolean; badge?: string; onClick?: () => void }) {
  const bg = pick(ds, ["background", "paper"], ds.colors[0]?.hex ?? "#f4f2ee");
  const ink = pick(ds, ["text", "ink"], "#1d1c1a");
  const accent = pick(ds, ["accent"], ds.colors[ds.colors.length - 1]?.hex ?? "#d9774f");
  const head = ds.fonts[0]?.stack ?? "inherit";
  const body = ds.fonts[1]?.stack ?? head;
  return (
    <button type="button" className={`ds-card${selected ? " selected" : ""}`} onClick={onClick}>
      {badge && <span className="ds-card-badge">{badge}</span>}
      <div className="ds-card-preview" style={{ background: bg, color: ink }}>
        <span className="ds-card-kicker" style={{ color: accent, fontFamily: body }}>
          {ds.fonts.map((f) => f.stack.match(/'([^']+)'/)?.[1] ?? f.stack.split(",")[0]).filter((v, i, a) => a.indexOf(v) === i).join(" / ")}
        </span>
        <span className="ds-card-name" style={{ fontFamily: head }}>
          {ds.name}
        </span>
        <span className="ds-card-strip">
          {ds.colors.slice(0, 8).map((c, i) => (
            <span key={i} style={{ background: c.hex }} title={`${c.name} ${c.hex}`} />
          ))}
        </span>
        <span className="ds-card-sample" style={{ fontFamily: body }}>
          <span>The quick brown fox jumps over the lazy dog.</span>
          <span className="ds-card-btn" style={{ background: accent, color: bg }}>
            Continue →
          </span>
        </span>
      </div>
      <span className="ds-card-label">{ds.name}</span>
    </button>
  );
}

/**
 * Pick one design system, or switch on Multi to combine several: the first
 * one chosen leads, the others are offered to the agent as secondary sources.
 */
export function DesignSystemPicker({
  systems,
  value,
  extra = [],
  onChange,
  variant = "large",
  side = "bottom",
}: {
  systems: DesignSystem[];
  value: string | null;
  extra?: string[];
  onChange: (primary: string | null, extra: string[]) => void;
  variant?: "large" | "chip";
  side?: "top" | "bottom";
}) {
  const [q, setQ] = useState("");
  const [multi, setMulti] = useState(extra.length > 0);
  const chosen = [value, ...extra].filter((v): v is string => !!v);
  const current = systems.find((s) => s.id === value) ?? null;
  const label = current ? `${current.name}${extra.length ? ` +${extra.length}` : ""}` : null;
  const shown = systems.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const groups = [
    { label: "Included design systems", items: shown.filter((s) => s.builtin) },
    { label: "Your design systems", items: shown.filter((s) => !s.builtin) },
  ].filter((g) => g.items.length);

  function toggle(id: string) {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id].slice(0, 5);
    onChange(next[0] ?? null, next.slice(1));
  }

  return (
    <Popover
      side={side}
      panelClassName="ds-pop"
      trigger={(open, toggleOpen) =>
        variant === "large" ? (
          <button type="button" className={`ds-trigger${open ? " open" : ""}`} onClick={toggleOpen}>
            <span className="ds-trigger-icon">
              <IconFeather size={20} />
            </span>
            <span className="ds-trigger-text">
              <span className="ds-trigger-kicker">
                Design system <IconChevronDown size={12} />
              </span>
              <span className="ds-trigger-name">{label ?? "None"}</span>
            </span>
          </button>
        ) : (
          <button type="button" className="chip-trigger" onClick={toggleOpen}>
            {label ?? "Design System"} <IconChevronDown size={12} />
          </button>
        )
      }
      render={(close) => (
        <>
          <DesignSystemFonts systems={systems} />
          <div className="pop-search-row">
            <label className="pop-search">
              <IconSearch size={14} />
              <input autoFocus placeholder="Search design systems" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <button
              type="button"
              className={`multi-btn${multi ? " on" : ""}`}
              title="Combine several design systems"
              onClick={() => {
                if (multi && extra.length) onChange(value, []);
                setMulti((v) => !v);
              }}
            >
              <IconList size={13} /> Multi
            </button>
            <button
              type="button"
              className="icon-btn"
              title="No design system"
              onClick={() => {
                onChange(null, []);
                close();
              }}
            >
              <IconClose size={14} />
            </button>
            <Link href="/design-systems?new=1" className="icon-btn" title="New design system">
              <IconPlus size={14} />
            </Link>
          </div>
          {multi && <div className="pop-hint">Pick several. The first one leads; the rest are extra sources.</div>}
          <div className="ds-pop-scroll">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="pop-label">{g.label}</div>
                <div className="ds-pop-grid">
                  {g.items.map((s) => (
                    <DesignSystemCard
                      key={s.id}
                      ds={s}
                      selected={chosen.includes(s.id)}
                      badge={multi && chosen.includes(s.id) ? String(chosen.indexOf(s.id) + 1) : undefined}
                      onClick={() => {
                        if (multi) return toggle(s.id);
                        onChange(s.id, []);
                        close();
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
            {!groups.length && <div className="pop-empty">No design systems match “{q}”.</div>}
          </div>
        </>
      )}
    />
  );
}

export function ModelPicker({
  models,
  value,
  onChange,
  variant = "large",
  side = "bottom",
}: {
  models: ModelOption[];
  value: ModelKey;
  onChange: (key: ModelKey) => void;
  variant?: "large" | "chip";
  side?: "top" | "bottom";
}) {
  const current = models.find((m) => m.key === value) ?? models[0];
  return (
    <Popover
      align="right"
      side={side}
      panelClassName="menu"
      trigger={(open, toggle) =>
        variant === "large" ? (
          <button type="button" className={`model-trigger${open ? " open" : ""}`} onClick={toggle}>
            <span className="model-trigger-kicker">
              Model <IconChevronDown size={12} />
            </span>
            <span className="model-trigger-name">{current.label}</span>
          </button>
        ) : (
          <button type="button" className="chip-trigger" onClick={toggle}>
            {current.label} <IconChevronDown size={12} />
          </button>
        )
      }
      render={(close) => (
        <>
          <div className="pop-label">Model</div>
          {models.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`menu-item${m.key === value ? " active" : ""}`}
              onClick={() => {
                onChange(m.key);
                close();
              }}
            >
              <span className="menu-item-label">
                {m.label}
                <span className="menu-item-sub">{m.note}</span>
              </span>
              {m.key === value && <IconCheck size={14} />}
            </button>
          ))}
        </>
      )}
    />
  );
}

type Repo = { full_name: string; description: string | null; private: boolean };
let repoCache: Promise<{ repos: Repo[]; error?: string; main?: boolean; connected?: string | null }> | null = null;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function CodebasePicker({ value, onChange }: { value: string | null; onChange: (repo: string | null) => void }) {
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The main key without a connected account gets a link to connect one; nobody else is offered it.
  const [canConnect, setCanConnect] = useState(false);

  function load() {
    repoCache ??= fetch("/api/repos")
      .then((r) => r.json())
      .catch(() => ({ repos: [] }));
    repoCache.then((d) => {
      setRepos(d.repos ?? []);
      setError(d.error ?? null);
      setCanConnect(!!d.main && !d.connected);
    });
  }

  const query = q.trim();
  const shown = (repos ?? []).filter((r) => r.full_name.toLowerCase().includes(query.toLowerCase()));
  const custom = REPO_RE.test(query) && !shown.some((r) => r.full_name.toLowerCase() === query.toLowerCase());

  return (
    <Popover
      panelClassName="menu repo-pop"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={`code-trigger${value ? " set" : ""}${open ? " open" : ""}`}
          title={value ? `Designing within ${value}` : "Connect a codebase for the agent to design within"}
          onClick={() => {
            if (!open) load();
            toggle();
          }}
        >
          <IconCode size={18} />
          {value && <span className="code-trigger-name">{value.split("/")[1]}</span>}
        </button>
      )}
      render={(close) => {
        const choose = (repo: string | null) => {
          onChange(repo);
          close();
        };
        return (
          <>
            <label className="pop-search">
              <IconSearch size={14} />
              <input autoFocus placeholder="Search repositories or type owner/repo" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="pop-label strong">Base designs off what&rsquo;s currently in code?</div>
            <button type="button" className={`menu-item${!value ? " active" : ""}`} onClick={() => choose(null)}>
              <span className="menu-item-label">None</span>
              {!value && <IconCheck size={14} />}
            </button>
            <div className="pop-sep" />
            <div className="pop-label">Codebase from GitHub</div>
            {canConnect && (
              <a className="menu-item" href="/access/github">
                <span className="menu-item-label">
                  <IconGithub size={14} /> Connect GitHub for your private repositories
                </span>
              </a>
            )}
            <div className="repo-scroll">
              {custom && (
                <button type="button" className="menu-item" onClick={() => choose(query)}>
                  <span className="menu-item-label">
                    <IconGithub size={14} /> Use {query}
                  </span>
                </button>
              )}
              {repos === null && <div className="pop-empty">Loading repositories…</div>}
              {shown.map((r) => (
                <button key={r.full_name} type="button" className={`menu-item${value === r.full_name ? " active" : ""}`} onClick={() => choose(r.full_name)}>
                  <span className="menu-item-label">
                    <IconCode size={14} />
                    <span>
                      {r.full_name}
                      {(r.private || r.description) && <span className="menu-item-sub">{r.private ? "private" : r.description}</span>}
                    </span>
                  </span>
                  {value === r.full_name && <IconCheck size={14} />}
                </button>
              ))}
              {repos !== null && !shown.length && !custom && (
                <div className="pop-empty">
                  {error ? "Couldn't list repositories. " : ""}Type <code>owner/repo</code> to connect a public repository.
                </div>
              )}
            </div>
          </>
        );
      }}
    />
  );
}
