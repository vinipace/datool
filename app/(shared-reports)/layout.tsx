// Keep public reports outside the workspace loading boundary so revoked links
// return HTTP 404 before any report content is streamed.
export { default, metadata } from "../(app)/layout"
