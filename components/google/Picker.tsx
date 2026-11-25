"use client";

import { useCallback, useEffect, useState } from "react";

// The Google Picker (drive.file): the user picks a Doc or a folder in Google's own dialog, which
// grants our app access to exactly that file. The access token comes from
// POST /api/google/picker-token (the user's own grant; never the refresh token).

export type PickerMode = "doc" | "folder" | "docs-multi" | "doc-or-pdf";

export interface PickedFile {
  id: string;
  name: string;
  mimeType: string;
  parentId?: string;
}

export interface PickerOptions {
  mode: PickerMode;
  /** Open in this folder (a doc mode). */
  parentId?: string;
  title: string;
}

/** Why the Picker could not open: the server's code and Swedish message. */
export class PickerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PickerError";
  }
}

const GAPI_SRC = "https://apis.google.com/js/api.js";
const DOC_MIME = "application/vnd.google-apps.document";
const PDF_MIME = "application/pdf";

/* Minimal typings for the parts of google.picker we use. */
interface PickerDoc {
  id: string;
  name?: string;
  mimeType?: string;
  parentId?: string;
}
interface PickerResponse {
  action: string;
  docs?: PickerDoc[];
}
interface DocsView {
  setMimeTypes(m: string): DocsView;
  setParent(id: string): DocsView;
  setSelectFolderEnabled(on: boolean): DocsView;
  setIncludeFolders(on: boolean): DocsView;
  setMode(mode: unknown): DocsView;
}
interface PickerBuilder {
  addView(v: DocsView): PickerBuilder;
  enableFeature(f: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setLocale(l: string): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  setCallback(cb: (r: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void; dispose(): void };
}
interface PickerNs {
  DocsView: new (viewId?: unknown) => DocsView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: unknown; FOLDERS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
  DocsViewMode: { LIST: unknown };
}
declare global {
  interface Window {
    gapi?: { load(name: string, cb: { callback: () => void; onerror?: () => void } | (() => void)): void };
    google?: { picker?: PickerNs };
  }
}

let loading: Promise<PickerNs> | null = null;

/** Load api.js once and then the picker module. */
function loadPicker(): Promise<PickerNs> {
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  loading ??= new Promise<PickerNs>((resolve, reject) => {
    const withGapi = () =>
      window.gapi!.load("picker", {
        callback: () => (window.google?.picker ? resolve(window.google.picker) : reject(new Error("picker missing"))),
        onerror: () => reject(new Error("picker load failed")),
      });
    if (window.gapi) return withGapi();
    const script = document.createElement("script");
    // A failed earlier attempt left its tag behind: replace it.
    document.querySelectorAll(`script[src="${GAPI_SRC}"]`).forEach((el) => el.remove());
    script.src = GAPI_SRC;
    script.async = true;
    script.onload = withGapi;
    script.onerror = () => reject(new Error("api.js load failed"));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null; // a later call may retry
    throw err;
  });
  return loading;
}

async function pickerToken(): Promise<{ accessToken: string; developerKey: string; appId: string }> {
  let res: Response;
  try {
    res = await fetch("/api/google/picker-token", { method: "POST", cache: "no-store" });
  } catch {
    throw new PickerError("network", "Vi nådde inte servern. Kontrollera nätet och försök igen.");
  }
  const json = (await res.json().catch(() => null)) as
    | { accessToken?: string; developerKey?: string; appId?: string; error?: string; message?: string }
    | null;
  if (!res.ok || !json?.accessToken || !json.developerKey || !json.appId) {
    throw new PickerError(json?.error ?? "picker_failed", json?.message ?? "Google-väljaren kunde inte öppnas. Försök igen.");
  }
  return { accessToken: json.accessToken, developerKey: json.developerKey, appId: json.appId };
}

/**
 * `open()` resolves with the picked files, or null when the user cancelled. It throws a
 * `PickerError` (Swedish message) when the token or Google's script is unavailable. `ready`
 * turns true once Google's script has loaded (it starts loading on mount).
 */
export function usePicker(): {
  ready: boolean;
  open(opts: PickerOptions): Promise<PickedFile[] | null>;
} {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    loadPicker().then(
      () => live && setReady(true),
      () => {}, // open() reports it
    );
    return () => {
      live = false;
    };
  }, []);

  const open = useCallback(async (opts: PickerOptions): Promise<PickedFile[] | null> => {
    const [picker, token] = await Promise.all([
      loadPicker().catch(() => {
        throw new PickerError("picker_load", "Google-väljaren kunde inte laddas. Kontrollera nätet och försök igen.");
      }),
      pickerToken(),
    ]);
    setReady(true);

    const views: DocsView[] = [];
    if (opts.mode === "folder") {
      views.push(new picker.DocsView(picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true));
    } else {
      const mimes = opts.mode === "doc-or-pdf" ? `${DOC_MIME},${PDF_MIME}` : DOC_MIME;
      // The folder first (when given), then all Docs: a Doc kept elsewhere can still be picked.
      if (opts.parentId) views.push(new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(mimes).setParent(opts.parentId));
      views.push(new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(mimes));
    }

    return new Promise<PickedFile[] | null>((resolve) => {
      let builder = new picker.PickerBuilder();
      for (const v of views) builder = builder.addView(v);
      builder = builder
        .setOAuthToken(token.accessToken)
        .setDeveloperKey(token.developerKey)
        .setAppId(token.appId)
        .setLocale("sv")
        .setTitle(opts.title);
      if (opts.mode === "docs-multi") builder = builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
      const dialog = builder
        .setCallback((r) => {
          if (r.action === picker.Action.PICKED) {
            dialog.dispose();
            resolve(
              (r.docs ?? []).map((d) => ({
                id: d.id,
                name: d.name ?? "",
                mimeType: d.mimeType ?? "",
                ...(d.parentId ? { parentId: d.parentId } : {}),
              })),
            );
          } else if (r.action === picker.Action.CANCEL) {
            dialog.dispose();
            resolve(null);
          }
        })
        .build();
      dialog.setVisible(true);
    });
  }, []);

  return { ready, open };
}
