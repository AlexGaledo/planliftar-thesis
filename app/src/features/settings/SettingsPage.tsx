/**
 * Settings: analysis server, live-map hub, demo mode, units, data.
 *
 * The connection form uses React Hook Form + Zod: Zod describes what a valid
 * value looks like (one schema = one source of truth for validation and types),
 * RHF tracks the inputs without re-rendering the whole page per keystroke.
 * Saved values go to the zustand settings store (persisted in localStorage).
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Dialog } from "@/components/Dialog";
import { apiBase, getPlanApi, hubUrl, mixedContentProblem, normalizeServerUrl } from "@/lib/api";
import { clearAllData } from "@/lib/db/projects";
import { addSamples } from "@/lib/db/samples";
import { useSettings, type HubMode } from "@/stores/settings";
import styles from "./settings.module.css";

const schema = z
  .object({
    serverUrl: z
      .string()
      .trim()
      .refine((v) => v === "" || isUrl(normalizeServerUrl(v), ["http:", "https:"]), "Type an address like https://192.168.1.42:8443, or leave it empty."),
    hubMode: z.enum(["auto", "legacy", "custom"]),
    hubUrl: z.string().trim(),
  })
  .refine((v) => v.hubMode !== "custom" || isUrl(v.hubUrl, ["ws:", "wss:"]), {
    path: ["hubUrl"],
    message: "Type a WebSocket address starting with ws:// or wss://.",
  });
type ConnectionValues = z.infer<typeof schema>;

function isUrl(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function SettingsPage() {
  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">Saved on this device only.</p>
        </div>
      </header>
      <ConnectionSection />
      <PreferencesSection />
      <DataSection />
    </div>
  );
}

function ConnectionSection() {
  const settings = useSettings();
  const [test, setTest] = useState<{ kind: "ok" | "error" | "busy"; text: string } | null>(null);
  const { register, handleSubmit, watch, formState, reset } = useForm<ConnectionValues>({
    resolver: zodResolver(schema),
    defaultValues: { serverUrl: settings.serverUrl, hubMode: settings.hubMode, hubUrl: settings.hubUrl },
  });
  const values = watch();
  const preview = {
    api: apiBase(values.serverUrl ?? ""),
    hub: hubUrl({ serverUrl: values.serverUrl ?? "", hubMode: values.hubMode as HubMode, hubUrl: values.hubUrl ?? "" }),
  };
  const mixed = mixedContentProblem(values.serverUrl ?? "");

  const onSave = handleSubmit((v) => {
    const serverUrl = normalizeServerUrl(v.serverUrl);
    settings.update({ serverUrl, hubMode: v.hubMode, hubUrl: v.hubUrl });
    reset({ ...v, serverUrl });
    setTest({ kind: "ok", text: "Saved." });
  });

  async function testConnection() {
    setTest({ kind: "busy", text: "Checking…" });
    try {
      const h = await getPlanApi({ demoMode: false, serverUrl: normalizeServerUrl(values.serverUrl ?? "") }).health();
      setTest({ kind: "ok", text: `Connected. Engine ${h.engine_version} on ${h.device === "cuda" ? "GPU" : "CPU"}.` });
    } catch (e) {
      setTest({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <section className={styles.section} aria-labelledby="conn-heading">
      <h2 id="conn-heading">Connection</h2>

      <label className="check">
        <input type="checkbox" checked={settings.demoMode} onChange={(e) => settings.update({ demoMode: e.target.checked })} />
        <span>
          Demo mode
          <span className="field-hint" style={{ display: "block" }}>
            No server needed. Uploads return a sample plan after a simulated analysis. Use for demos and development.
          </span>
        </span>
      </label>

      <form className="stack" onSubmit={onSave} noValidate>
        <div className="field">
          <label htmlFor="server-url">Analysis server</label>
          <input id="server-url" className="input" placeholder="Same as this site" inputMode="url" autoComplete="off" spellCheck={false} {...register("serverUrl")} aria-invalid={!!formState.errors.serverUrl} aria-describedby="server-url-hint" />
          <span id="server-url-hint" className="field-hint">
            Leave empty when the app is served by the laptop server. For the hosted app, type the laptop&apos;s address on this Wi-Fi,
            e.g. https://192.168.1.42:8443. Open that address once in this browser and accept its certificate first.
          </span>
          {formState.errors.serverUrl && <span className="field-error">{formState.errors.serverUrl.message}</span>}
          {mixed && <span className="field-error">{mixed}</span>}
        </div>

        <fieldset className={styles.fieldset}>
          <legend className="field-label">Live map hub</legend>
          <label className="check">
            <input type="radio" value="auto" {...register("hubMode")} />
            <span>Same server, path /ws (recommended)</span>
          </label>
          <label className="check">
            <input type="radio" value="legacy" {...register("hubMode")} />
            <span>Old standalone hub on port 8765 (server.py)</span>
          </label>
          <label className="check">
            <input type="radio" value="custom" {...register("hubMode")} />
            <span>Custom address</span>
          </label>
          {values.hubMode === "custom" && (
            <div className="field">
              <label htmlFor="hub-url">Hub address</label>
              <input id="hub-url" className="input" placeholder="wss://192.168.1.42:8765" spellCheck={false} {...register("hubUrl")} aria-invalid={!!formState.errors.hubUrl} />
              {formState.errors.hubUrl && <span className="field-error">{formState.errors.hubUrl.message}</span>}
            </div>
          )}
        </fieldset>

        <dl className={styles.preview}>
          <dt>Requests go to</dt>
          <dd>
            <code>{preview.api}</code>
          </dd>
          <dt>Live map connects to</dt>
          <dd>
            <code>{preview.hub}</code>
          </dd>
        </dl>

        <div className="row">
          <button className="btn btn-primary" type="submit">
            Save connection
          </button>
          <button className="btn" type="button" onClick={() => void testConnection()} disabled={test?.kind === "busy"}>
            Test connection
          </button>
        </div>
        {test && (
          <p className={`notice small ${test.kind === "error" ? "notice-error" : test.kind === "ok" ? "notice-live" : ""}`} role={test.kind === "error" ? "alert" : "status"}>
            {test.text}
          </p>
        )}
      </form>
    </section>
  );
}

function PreferencesSection() {
  const units = useSettings((s) => s.units);
  const closeGaps = useSettings((s) => s.closeGaps);
  const update = useSettings((s) => s.update);
  return (
    <section className={styles.section} aria-labelledby="pref-heading">
      <h2 id="pref-heading">Preferences</h2>
      <fieldset className={styles.fieldset}>
        <legend className="field-label">Units</legend>
        <div className="seg" style={{ maxWidth: 360 }}>
          <button type="button" aria-pressed={units === "metric"} onClick={() => update({ units: "metric" })}>
            Metres
          </button>
          <button type="button" aria-pressed={units === "imperial"} onClick={() => update({ units: "imperial" })}>
            Feet
          </button>
        </div>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={closeGaps} onChange={(e) => update({ closeGaps: e.target.checked })} />
        <span>
          Close small gaps between walls
          <span className="field-hint" style={{ display: "block" }}>
            Joins wall ends the AI left apart. Doorways stay open. Turn off to see the raw AI output.
          </span>
        </span>
      </label>
    </section>
  );
}

function DataSection() {
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const resetSettings = useSettings((s) => s.reset);
  return (
    <section className={styles.section} aria-labelledby="data-heading">
      <h2 id="data-heading">Data on this device</h2>
      <div className="row">
        <button
          className="btn"
          type="button"
          onClick={async () => {
            try {
              const n = await addSamples();
              setMessage(`Added ${n} example plans to your projects.`);
            } catch (e) {
              setMessage((e as Error).message);
            }
          }}
        >
          Add the example plans
        </button>
        <button className="btn btn-danger" type="button" onClick={() => setConfirm(true)}>
          Clear all data
        </button>
      </div>
      {message && (
        <p className="notice small" role="status">
          {message}
        </p>
      )}
      <Dialog open={confirm} title="Clear all data?" onClose={() => setConfirm(false)}>
        <p>Every project, source image and setting on this device will be removed. Projects are not stored anywhere else.</p>
        <div className="row">
          <button
            className="btn btn-danger"
            type="button"
            onClick={async () => {
              await clearAllData();
              resetSettings();
              setConfirm(false);
              setMessage("All data cleared.");
            }}
          >
            Clear everything
          </button>
          <button className="btn btn-quiet" type="button" onClick={() => setConfirm(false)} autoFocus>
            Cancel
          </button>
        </div>
      </Dialog>
    </section>
  );
}
