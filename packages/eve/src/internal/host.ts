export { buildApplication } from "#internal/host/build-application.js";
export {
  createDevelopmentServer,
  isActiveDevelopmentServerForApp,
} from "#internal/host/start-development-server.js";
export { startProductionServer } from "#internal/host/start-production-server.js";
export type {
  DevelopmentServer,
  DevelopmentServerHandle,
  DevelopmentServerOptions,
  ExistingDevelopmentServer,
  ProductionServerHandle,
  StartedDevelopmentServer,
} from "#internal/host/types.js";
