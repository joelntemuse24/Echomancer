/**
 * Re-exports Whole-book dispatch. The VM worker is the default host when
 * `WORKER_URL` is set; Trigger.dev remains the path when it is not.
 */

export {
  TAKEHOME_ADVANCE_TASK_ID,
  assertCanDispatchTakehome,
  canDispatchTakehome,
  enqueueTakehomeAdvance,
  isProductionDispatch,
  isTakehomeTriggerFallbackEnabled,
  isTakehomeWorkerConfigured,
  isTriggerTakehomeConfigured,
} from "@/lib/jobs/takehome-dispatch";
