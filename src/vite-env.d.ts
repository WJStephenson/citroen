/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Path the PWA prefixes onto every bridge call. nginx strips it. */
  readonly VITE_API_BASE?: string
  /** Default VIN; can be overridden at runtime from Settings. */
  readonly VITE_VIN?: string
  /** Background poll interval in minutes. Floor of 20 is enforced in config.ts. */
  readonly VITE_POLL_MINUTES?: string
  /** Dev-server only: where /api/* is proxied. */
  readonly VITE_API_PROXY_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
