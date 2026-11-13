// Fonts are served by the app itself. There is no font CDN: `EXCALIDRAW_ASSET_PATH`
// points at the build's own base, so a deployment makes no outbound font request.

/**
 * Custom vite plugin for auto-prefixing `EXCALIDRAW_ASSET_PATH` woff2 fonts in `excalidraw-app`.
 *
 * @returns {import("vite").PluginOption}
 */
module.exports.woff2BrowserPlugin = () => {
  let isDev;
  let base = "/";

  return {
    name: "woff2BrowserPlugin",
    enforce: "pre",
    config(_, { command }) {
      isDev = command === "serve";
    },
    configResolved(resolved) {
      base = resolved.base || "/";
    },
    transform(code, id) {
      // `packages/excalidraw/fonts/fonts.css` is left untouched: vite emits the
      // UI fonts it references from this repo, so nothing is fetched remotely.
      if (!isDev && id.endsWith("excalidraw-app/index.html")) {
        return code.replace(
          "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
          `<script>
        // fonts are served by this deployment, from its own base
        window.EXCALIDRAW_ASSET_PATH = ["${base}"];
      </script>`,
        );
      }
    },
  };
};
