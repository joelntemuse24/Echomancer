import {
  defineConfig
} from "../../chunk-YRH5LNF5.mjs";
import "../../chunk-ZA54C3FN.mjs";
import {
  init_esm
} from "../../chunk-K2JOEPVM.mjs";

// trigger.config.ts
init_esm();
var trigger_config_default = defineConfig({
  project: "proj_jtxihwmkgacyxxtkmvkh",
  runtime: "node",
  logLevel: "log",
  // 30 minutes
  maxDuration: 1800,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1e3,
      maxTimeoutInMs: 1e4,
      factor: 2
    }
  },
  build: {}
});
var resolveEnvVars = void 0;
export {
  trigger_config_default as default,
  resolveEnvVars
};
//# sourceMappingURL=trigger.config.mjs.map
