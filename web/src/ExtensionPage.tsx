// An extension's web UI, rendered as a sandboxed iframe filling the content area.
//
// The page is served self-contained from `<extension dir>/web/` at /ext/<name>/. It can call
// its own `/api/ext/<name>/...` routes and the public `/api/*` surface. Iframe-in-shell keeps
// zero coupling to the host bundle — no shared modules, no module federation.
export function ExtensionPage({ name }: { name: string }) {
  return (
    <iframe
      title={name}
      src={`/ext/${name}/`}
      className="h-full w-full border-0 bg-surface"
      sandbox="allow-same-origin allow-scripts allow-forms"
    />
  );
}
