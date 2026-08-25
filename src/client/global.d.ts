// Payloads injected by the server-rendered pages (see src/render.ts). Each
// page sets exactly one mode flag; the client dispatches on which one exists.
interface Window {
  __DIFF__?: any;
  __DOC__?: any;
  __COMMIT__?: any;
  __SNAPSHOT__?: any;
  __FILE__?: any;
  __TREE__?: any;
}
