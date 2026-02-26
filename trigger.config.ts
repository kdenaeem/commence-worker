import { defineConfig } from "@trigger.dev/sdk/v3";
import { esbuildPlugin } from "@trigger.dev/build/extensions";
import { tsConfigPaths } from "@trigger.dev/build/extensions";
import path from "path";

export default defineConfig({
    project: "proj_qhquooryqqxtiyvnlvyy",
    runtime: "node",
    logLevel: "info",
    retries: {
        enabledInDev: true,
        default: {
            maxAttempts: 3,
            minTimeoutInMs: 1000,
            maxTimeoutInMs: 10000,
            factor: 2,
            randomize: true,
        },
    },
    dirs: ["./src/trigger"],
    maxDuration: 600,
    build: {
        external: [
            "playwright",
            "playwright-core",
            "chromium-bidi",
            "@playwright/test",
        ],
        extensions: [
            tsConfigPaths(),
        ],
    },
});
