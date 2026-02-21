import { defineConfig } from "@trigger.dev/sdk/v3";

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
    },

});
