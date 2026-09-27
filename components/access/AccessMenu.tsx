"use client";

import { useEffect, useState } from "react";
import Popover, { MenuItem } from "@/components/ui/Popover";

/** The avatar menu: key management for the main key, and signing out. */
export default function AccessMenu() {
  const [me, setMe] = useState<{ kind: "main" | "temp" | null; expires: string | null } | null>(null);
  useEffect(() => {
    fetch("/api/access/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => {});
  }, []);

  async function signOut() {
    await fetch("/api/access/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/access");
  }

  return (
    <Popover
      align="right"
      panelClassName="menu"
      trigger={(_open, toggle) => (
        <button type="button" className="avatar" onClick={toggle} aria-label="Account" title={me?.kind === "main" ? "Main key" : me?.kind === "temp" ? "Temporary key" : "You"}>
          {me?.kind === "main" ? "M" : me?.kind === "temp" ? "T" : "Y"}
        </button>
      )}
      render={(close) => (
        <>
          <div className="menu-note">
            {me?.kind === "main"
              ? "Signed in with the main key"
              : me?.kind === "temp"
                ? `Temporary key${me.expires ? `, until ${new Date(me.expires).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}`
                : "Not signed in"}
          </div>
          {me?.kind === "main" && (
            <MenuItem
              onClick={() => {
                close();
                window.location.assign("/access/keys");
              }}
            >
              Access keys
            </MenuItem>
          )}
          {me?.kind === "main" && (
            <MenuItem
              onClick={() => {
                close();
                window.location.assign("/access/models");
              }}
            >
              Models
            </MenuItem>
          )}
          {me?.kind && (
            <MenuItem danger onClick={signOut}>
              Sign out
            </MenuItem>
          )}
        </>
      )}
    />
  );
}
