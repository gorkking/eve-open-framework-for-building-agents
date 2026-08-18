import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { eveReactRouter } from "eve/react-router";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [eveReactRouter(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
});
